# appium-remote-debugger

[![Build Status](https://travis-ci.org/appium/appium-remote-debugger.svg)](https://travis-ci.org/appium/appium-remote-debugger)
[![Dependency Status](https://david-dm.org/appium/appium-remote-debugger.svg)](https://david-dm.org/appium/appium-remote-debugger)
[![devDependency Status](https://david-dm.org/appium/appium-remote-debugger/dev-status.svg)](https://david-dm.org/appium/appium-remote-debugger#info=devDependencies)
[![Coverage Status](https://coveralls.io/repos/appium/appium-remote-debugger/badge.svg?branch=master&service=github)](https://coveralls.io/github/appium/appium-remote-debugger?branch=master)

A Node.js frontend for the Remote Debugger protocol used by Appium to connect to iOS webviews and Safari. Written using ES6+.

## API

This is an event emitter, which emits a `RemoteDebugger.EVENT_PAGE_CHANGE` event when there has been a change to the page. This should be caught and handled as the calling code wishes. It also emits a `RemoteDebugger.EVENT_DISCONNECT` event when the server disconnects the last application connected.

The steps to using the `RemoteDebugger` involve instantiating an object, then running `connect` and `selectApp`. After this the instance will be listening for events from the server (i.e., the webview or browser).


## Watch

```
npm run watch
```

```
gulp watch
```

## Test

```
npm test
```
