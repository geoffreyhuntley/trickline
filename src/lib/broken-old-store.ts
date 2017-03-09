import { Observable } from 'rxjs/Observable';
import { AsyncSubject } from 'rxjs/AsyncSubject';

import Dexie from 'dexie';

import { User, ChannelBase, Message, UsersCounts } from './models/api-shapes';
import { Pair } from './utils';
import { Store, ChannelList } from './store';
import { Api, createApi, infoApiForChannel } from './models/slack-api';
import { SparseMap, LRUSparseMap, InMemorySparseMap } from './sparse-map';
import { EventType } from './models/event-type';
import { Updatable } from './updatable';
import { asyncMap } from './promise-extras';

import './lib/standard-operators';
import 'rxjs/add/observable/dom/webSocket';

const VERSION = 1;

export interface DeferredPutItem<T> {
  item: T;
  completion: AsyncSubject<void>;
}

declare module 'dexie' {
  module Dexie {
    interface Table<T, Key> {
      deferredPut: ((item: T) => Promise<void>);
      idleHandle: number | null;
      deferredItems: DeferredPutItem<T>[];
    }
  }
}

function deferredPut<T, Key>(this: Dexie.Table<T, Key>, item: T): Promise<void> {
  let newItem = { item, completion: new AsyncSubject<void>() };

  let createIdle = () => window.requestIdleCallback(deadline => {
    while (deadline.timeRemaining() > 5/*ms*/) {
      let itemsToAdd = this.deferredItems;
      this.deferredItems = itemsToAdd.splice(128);

      this.bulkPut(itemsToAdd.map(x => Object.assign({}, x.item, { api: null })));
      itemsToAdd.forEach(x => { x.completion.next(undefined); x.completion.complete(); });
    }

    if (this.deferredItems.length) {
      this.idleHandle = createIdle();
    } else {
      this.idleHandle = null;
    }
  });

  this.deferredItems = this.deferredItems || [];
  this.deferredItems.push(newItem);
  if (!this.idleHandle) {
    this.idleHandle = createIdle();
  }

  return newItem.completion.toPromise();
}

export class DataModel extends Dexie  {
  users: Dexie.Table<User, string>;
  channels: Dexie.Table<ChannelBase, string>;
  keyValues: Dexie.Table<Pair<string, string>, string>;

  constructor() {
    super('SparseMap');

    this.version(VERSION).stores({
      users: 'id,name,real_name,color,profile',
      channels: 'id,name,is_starred,unread_count_display,mention_count,dm_count,user,topic,purpose',
      keyValues: 'key,value'
    });

    Object.getPrototypeOf(this.users).deferredPut = deferredPut;
  }
}

export class BrokenOldStoreThatDoesntWorkRight implements Store {
  api: Api[];
  database: DataModel;

  channels: SparseMap<string, ChannelBase>;
  users: SparseMap<string, User>;
  events: SparseMap<EventType, Message>;
  joinedChannels: Updatable<ChannelList>;
  keyValueStore: SparseMap<string, any>;

  constructor(tokenList: string[] = []) {
    this.api = tokenList.map(x => createApi(x));
    this.database = new DataModel();
    this.database.open();

    this.channels = new LRUSparseMap<ChannelBase>((channel, api: Api) => {
      let apiCall = infoApiForChannel(channel, api);

      return Observable.fromPromise(this.database.users.get(channel))
        .flatMap(x => x ? Observable.of(x) : apiCall);
    }, 'merge');

    this.channels.created.subscribe(u => {
      u.Value
        .flatMap(async v => {
          try {
            let toSave = Object.assign({}, v);
            delete toSave.api;

            await this.database.channels.deferredPut(toSave);
            //console.log(`Saving channel ${v.id}`);
          } catch (e) {
            console.log(`Can't save channel info! ${e.message}`);
          }
        })
        .subscribe();
    });

    this.users = new LRUSparseMap<User>((user, api: Api) => {
      let apiCall = api.users.info({ user }).map(({ user }: { user: User }) => {
        user.api = api;
        return user;
      });

      return Observable.fromPromise(this.database.users.get(user))
        .flatMap(x => x ? Observable.of(x) : apiCall)
        .catch(() => apiCall);
    }, 'merge');

    this.users.created.subscribe(u => {
      u.Value
        .flatMap(v => this.database.users.deferredPut(v).catch(() => Observable.empty()))
        .subscribe();
    });

    this.keyValueStore = new LRUSparseMap<string>((key) =>
      this.database.keyValues.get(key).then(x => x ? JSON.parse(x.Value) : null));

    this.keyValueStore.created
      .flatMap(x => x.Value.map(v => ({ Key: x.Key, Value: JSON.stringify(v) })))
      .flatMap(x => this.database.keyValues.deferredPut(x))
      .subscribe();

    this.joinedChannels = new Updatable<ChannelList>(() => Observable.of([]));

    this.events = new InMemorySparseMap<EventType, Message>();
    this.events.listen('user_change')
      .skip(1)
      .subscribe(msg => this.users.listen((msg.user! as User).id, msg.api).next(msg.user as User));

    // NB: This is the lulzy way to update channel counts when marks
    // change, but we should definitely remove this code later
    let somethingMarked = Observable.merge(
      this.events.listen('channel_marked'),
      this.events.listen('im_marked'),
      this.events.listen('group_marked')
    ).skip(3);

    somethingMarked.throttleTime(3000)
      .subscribe(x => this.fetchSingleInitialChannelList(x.api));

    this.connectToRtm()
      .groupBy(x => x.type)
      .retry()
      .subscribe(x => x.multicast(this.events.listen(x.key)).connect());
  }

  async fetchInitialChannelList(): Promise<void> {
    const results = await asyncMap(this.api, (api) => this.fetchSingleInitialChannelList(api));

    const allJoinedChannels = Array.from(results.values())
      .reduce((acc, x) => acc.concat(x), []);

    this.joinedChannels.next(allJoinedChannels);
  }

  connectToRtm(): Observable<Message> {
    return Observable.merge(
      ...this.api.map(x => this.createRtmConnection(x).retry(5).catch(e => {
        console.log(`Failed to connect via token ${x} - ${e.message}`);
        return Observable.empty();
      })));
  }

  private async fetchSingleInitialChannelList(api: Api): Promise<ChannelList> {
    const joinedChannels: ChannelList = [];

    const result: UsersCounts = await api.users.counts({ simple_unreads: true }).toPromise();

    result.channels.forEach((c) => {
      joinedChannels.push(this.makeUpdatableForModel(c, api));
    });

    result.groups.forEach((g) => {
      joinedChannels.push(this.makeUpdatableForModel(g, api));
    });

    result.ims.forEach((dm) => {
      joinedChannels.push(this.makeUpdatableForModel(dm, api));
    });

    return joinedChannels;
  }

  private makeUpdatableForModel(model: ChannelBase & Api, api: Api) {
    model.api = api;

    const updater = this.channels.listen(model.id, api);
    updater.next(model);
    return updater;
  }

  private createRtmConnection(api: Api): Observable<Message> {
    return api.rtm.connect()
      .flatMap(({url}) => Observable.webSocket(url))
      .map(msg => { msg.api = api; return msg; });
  }
}