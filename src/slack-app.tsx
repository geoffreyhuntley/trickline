// tslint:disable-next-line:no-unused-variable
import * as React from 'react';

// tslint:disable-next-line:no-unused-variable
import { Observable } from 'rxjs/Observable';

import Drawer from 'material-ui/Drawer';
import MuiThemeProvider from 'material-ui/styles/MuiThemeProvider';
import getMuiTheme from 'material-ui/styles/getMuiTheme';

import { Action } from './lib/action';
import { SimpleView } from './lib/view';
import { fromObservable, Model, notify } from './lib/model';
import { Store, NaiveStore } from './lib/store';
import { DexieStore } from './lib/dexie-store';
import { handleRtmMessagesForStore, connectToRtm, fetchInitialChannelList } from './lib/store-network';

import { ChannelHeaderViewModel, ChannelHeaderView } from './channel-header';
import { ChannelListViewModel, ChannelListView } from './channel-list';
import { MemoryPopover } from './memory-popover';
import { MessagesViewModel, MessagesView } from './messages-view';
import { when } from './lib/when';
//import { takeHeapSnapshot } from './profiler';

import './lib/standard-operators';
import { SerialSubscription } from './lib/serial-subscription';

export const DrawerWidth = 300;

export interface SlackAppState {
  drawerOpen: boolean;
}

const slackTheme = getMuiTheme({
  fontFamily: 'Slack-Lato',

  // Customize our color palette with:
  palette: {
    // textColor: cyan500,
  },

  // Customize individual components like:
  appBar: {
    height: 50,
  }
});

@notify('channelList')
export class SlackAppModel extends Model {
  store: Store;
  channelList: ChannelListViewModel;
  channelHeader: ChannelHeaderViewModel;
  loadInitialState: Action<void>;
  @fromObservable isDrawerOpen: boolean;
  @fromObservable messagesViewModel: MessagesViewModel;

  constructor() {
    super();

    // NB: Solely for debugging purposes
    global.slackApp = this;

    const tokenSource = process.env.SLACK_API_TOKEN || window.localStorage.getItem('token') || '';
    const tokens = tokenSource.indexOf(',') >= 0 ? tokenSource.split(',') : [tokenSource];

    this.store = new DexieStore(tokens);
    this.channelHeader = new ChannelHeaderViewModel(this.store);

    when(this, x => x.channelHeader.isDrawerOpen)
      .toProperty(this, 'isDrawerOpen');

    when(this, x => x.channelList.selectedChannel)
      .filter(channel => !!channel)
      .do((x) => this.channelHeader.selectedChannel = x)
      .map(channel => new MessagesViewModel(this.store, channel))
      .toProperty(this, 'messagesViewModel');

    this.channelList = new ChannelListViewModel(this.store);
    when(this, x => x.isDrawerOpen)
      .skip(1)
      .filter(x => !x)
      .subscribe(() => this.channelList = new ChannelListViewModel(this.store));

    const rtmSub = new SerialSubscription();
    rtmSub.set(handleRtmMessagesForStore(connectToRtm(this.store.api), this.store));

    this.loadInitialState = new Action<void>(() => fetchInitialChannelList(this.store), undefined);
  }
}

export class SlackApp extends SimpleView<SlackAppModel> {
  constructor() {
    super();
    this.viewModel = new SlackAppModel();
    this.viewModel.loadInitialState.execute();

    if ('type' in process && process.env['TRICKLINE_HEAPSHOT_AND_BAIL']) {
      const {createProxyForRemote} = require('electron-remote');
      const mainProcess = createProxyForRemote(null);
      this.takeHeapshot().then(() => mainProcess.tracingControl.stopTracing(true));
    }

    when(this, x => x.viewModel.channelList.selectedChannel)
      .skip(1)
      .filter(() => this.viewModel.isDrawerOpen && window.outerWidth < window.outerHeight)
      .subscribe(() => this.viewModel.channelHeader.toggleDrawer.execute());
  }

  async takeHeapshot() {
    await this.viewModel.channelHeader.toggleDrawer.execute().toPromise();
    await this.viewModel.store.joinedChannels
      .filter((x: any) => x && x.length > 0)
      .take(1)
      .timeout(10 * 1000)
      .catch(() => Observable.of(true))
      .toPromise();

    await Observable.timer(250).toPromise();
    //await takeHeapSnapshot();
  }

  render() {
    const vm = this.viewModel!;
    const shouldShift = vm.isDrawerOpen && window.outerWidth > window.outerHeight;
    const containerStyle = {
      height: '100%',
      marginLeft: shouldShift ? `${DrawerWidth}px` : '0px',
      transition: 'margin-left: 450ms cubic-bezier(0.23, 1, 0.32, 1) 0ms'
    };

    const channelListView = vm.isDrawerOpen ? (
      <ChannelListView viewModel={vm.channelList} />
    ) : null;

    const messagesView = vm.messagesViewModel ? (
      <MessagesView
        key={vm.messagesViewModel.channel.id}
        viewModel={vm.messagesViewModel}
      />
    ) : null;

    return (
      <MuiThemeProvider muiTheme={slackTheme}>
        <div style={containerStyle}>
          <ChannelHeaderView viewModel={vm.channelHeader} />

          <Drawer open={vm.isDrawerOpen} zDepth={1} width={DrawerWidth}>
            {channelListView}
          </Drawer>

          {messagesView}
          <MemoryPopover />
        </div>
      </MuiThemeProvider>
    );
  }
}
