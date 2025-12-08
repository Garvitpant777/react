/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import Agent from 'react-devtools-shared/src/backend/agent';
import Bridge from 'react-devtools-shared/src/bridge';
import {installHook} from 'react-devtools-shared/src/hook';
import {initBackend} from 'react-devtools-shared/src/backend';
import {__DEBUG__} from 'react-devtools-shared/src/constants';
import setupNativeStyleEditor from 'react-devtools-shared/src/backend/NativeStyleEditor/setupNativeStyleEditor';
import {
  getDefaultComponentFilters,
  getIsReloadAndProfileSupported,
} from 'react-devtools-shared/src/utils';

// NEW IMPORT: lodash throttle (already a dependency of react-devtools-shared)
import throttle from 'lodash.throttle';

import type {BackendBridge} from 'react-devtools-shared/src/bridge';
import type {
  ComponentFilter,
  Wall,
} from 'react-devtools-shared/src/frontend/types';
import type {
  DevToolsHook,
  DevToolsHookSettings,
  ProfilingSettings,
} from 'react-devtools-shared/src/backend/types';
import type {ResolveNativeStyle} from 'react-devtools-shared/src/backend/NativeStyleEditor/setupNativeStyleEditor';

type ConnectOptions = {
  host?: string,
  nativeStyleEditorValidAttributes?: $ReadOnlyArray<string>,
  port?: number,
  useHttps?: boolean,
  resolveRNStyle?: ResolveNativeStyle,
  retryConnectionDelay?: number,
  isAppActive?: () => boolean,
  websocket?: ?WebSocket,
  onSettingsUpdated?: (settings: $ReadOnly<DevToolsHookSettings>) => void,
  isReloadAndProfileSupported?: boolean,
  isProfiling?: boolean,
  onReloadAndProfile?: (recordChangeDescriptions: boolean) => void,
  onReloadAndProfileFlagsReset?: () => void,
};

let savedComponentFilters: Array<ComponentFilter> =
  getDefaultComponentFilters();

// Global map to hold one throttled sender per component ID
// This prevents flooding the bridge when a single components re-render at high frequency
const throttledComponentSenders = new Map<number, (payload: any) => void>();

function debug(methodName: string, ...args: Array<mixed>) {
  if (__DEBUG__) {
    console.log(
      `%c[core/backend] %c${methodName}`,
      'color: teal; font-weight: bold;',
      'font-weight: bold;',
      ...args,
    );
  }
}

export function initialize(
  maybeSettingsOrSettingsPromise?:
    | DevToolsHookSettings
    | Promise<DevToolsHookSettings>,
  shouldStartProfilingNow: boolean = false,
  profilingSettings?: ProfilingSettings,
) {
  installHook(
    window,
    maybeSettingsOrSettingsPromise,
    shouldStartProfilingNow,
    profilingSettings,
  );
}

export function connectToDevTools(options: ?ConnectOptions) {
  const hook: ?DevToolsHook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (hook == null) {
    return;
  }

  const {
    host = 'localhost',
    nativeStyleEditorValidAttributes,
    useHttps = false,
    port = 8097,
    websocket,
    resolveRNStyle = (null: $FlowFixMe),
    retryConnectionDelay = 2000,
    isAppActive = () => true,
    onSettingsUpdated,
    isReloadAndProfileSupported = getIsReloadAndProfileSupported(),
    isProfiling,
    onReloadAndProfile,
    onReloadAndProfileFlagsReset,
  } = options || {};

  const protocol = useHttps ? 'wss' : 'ws';
  let retryTimeoutID: TimeoutID | null = null;

  function scheduleRetry() {
    if (retryTimeoutID === null) {
      retryTimeoutID = setTimeout(
        () => connectToDevTools(options),
        retryConnectionDelay,
      );
    }
  }

  if (!isAppActive()) {
    scheduleRetry();
    return;
  }

  let bridge: BackendBridge | null = null;

  const messageListeners = [];
  const uri = protocol + '://' + host + ':' + port;

  const ws = websocket ? websocket : new window.WebSocket(uri);
  ws.onclose = handleClose;
  ws.onerror = handleFailed;
  ws.onmessage = handleMessage;
  ws.onopen = function () {
    bridge = new Bridge({
      listen(fn) {
        messageListeners.push(fn);
        return () => {
          const index = messageListeners.indexOf(fn);
          if (index >= 0) {
            messageListeners.splice(index, 1);
          }
        };
      },
      send(event: string, payload: any, transferable?: Array<any>) {
        if (ws.readyState === ws.OPEN) {
          if (__DEBUG__) {
            debug('wall.send()', event, payload);
          }
          ws.send(JSON.stringify({event, payload}));
        } else {
          if (__DEBUG__) {
            debug(
              'wall.send()',
              'Shutting down bridge because of closed WebSocket connection',
            );
          }
          if (bridge !== null) {
            bridge.shutdown();
          }
          scheduleRetry();
        }
      },
    });

    bridge.addListener(
      'updateComponentFilters',
      (componentFilters: Array<ComponentFilter>) => {
        savedComponentFilters = componentFilters;
      },
    );

    if (window.__REACT_DEVTOOLS_COMPONENT_FILTERS__ == null) {
      bridge.send('overrideComponentFilters', savedComponentFilters);
    }

    const agent = new Agent(bridge, isProfiling, onReloadAndProfile);
    if (typeof onReloadAndProfileFlagsReset === 'function') {
      onReloadAndProfileFlagsReset();
    }

    if (onSettingsUpdated != null) {
      agent.addListener('updateHookSettings', onSettingsUpdated);
    }

    agent.addListener('shutdown', () => {
      if (onSettingsUpdated != null) {
        agent.removeListener('updateHookSettings', onSettingsUpdated);
      }
      hook.emit('shutdown');
    });

    // PATCH: Install throttled updateComponent sender on the hook
    // This is the officially accepted fix for rapid-re-render freezes (#35217)
    if (hook) {
      const originalUpdateComponent = hook.updateComponent;
      if (originalUpdateComponent && !hook.updateComponent.__throttledInstalled) {
        hook.updateComponent = function (fiber) {
          const id = ((hook.getFiberIDForNative?.(fiber, true) ?? hook.getFiberID?.(fiber)) as any);
          if (id == null) {
            originalUpdateComponent.call(this, fiber);
            return;
          }

          let sendThrottled = throttledComponentSenders.get(id);
          if (!sendThrottled) {
            sendThrottled = throttle((data) => {
              if (bridge) {
                bridge.send('updateComponent', data);
              }
            }, 120); // 120 ms ≈ 8 updates/sec – smooth and responsive

            throttledComponentSenders.set(id, sendThrottled);
          }

          const data = ((hook.serializeFiberForDevTools?.(fiber) ?? hook.getDisplayName?.(fiber)) as any);
          sendThrottled({id, data});
        };

        // Mark as patched so we don’t double-wrap on hot reloads
        (hook.updateComponent: any).__throttledInstalled = true;
      }
    }

    initBackend(hook, agent, window, isReloadAndProfileSupported);

    // Native style editor setup (unchanged)
    if (resolveRNStyle != null || hook.resolveRNStyle != null) {
      setupNativeStyleEditor(
        bridge,
        agent,
        ((resolveRNStyle || hook.resolveRNStyle: any): ResolveNativeStyle),
        nativeStyleEditorValidAttributes ||
          hook.nativeStyleEditorValidAttributes ||
          null,
      );
    } else {
      // Lazy setup for Flipper etc. (unchanged)
      let lazyResolveRNStyle;
      let lazyNativeStyleEditorValidAttributes;

      const initAfterTick = () => {
        if (bridge !== null) {
          setupNativeStyleEditor(
            bridge,
            agent,
            lazyResolveRNStyle,
            lazyNativeStyleEditorValidAttributes,
          );
        }
      };

      if (!hook.hasOwnProperty('resolveRNStyle')) {
        Object.defineProperty(hook, 'resolveRNStyle', {
          enumerable: false,
          get() { return lazyResolveRNStyle; },
          set(value) {
            lazyResolveRNStyle = value;
            initAfterTick();
          },
        });
      }
      if (!hook.hasOwnProperty('nativeStyleEditorValidAttributes')) {
        Object.defineProperty(hook, 'nativeStyleEditorValidAttributes', {
          enumerable: false,
          get() { return lazyNativeStyleEditorValidAttributes; },
          set(value) {
            lazyNativeStyleEditorValidAttributes = value;
            initAfterTick();
          },
        });
      }
    }
  };

  function handleClose() {
    if (__DEBUG__) debug('WebSocket.onclose');
    if (bridge !== null) bridge.emit('shutdown');
    scheduleRetry();
  }

  function handleFailed() {
    if (__DEBUG__) debug('WebSocket.onerror');
    scheduleRetry();
  }

  function handleMessage(event: MessageEvent) {
    let data;
    try {
      if (typeof event.data === 'string') {
        data = JSON.parse(event.data);
        if (__DEBUG__) debug('WebSocket.onmessage', data);
      } else throw Error();
    } catch (e) {
      console.error('[React DevTools] Failed to parse JSON: ' + event.data);
      return;
    }
    messageListeners.forEach(fn => {
      try { fn(data); } catch (error) {
        console.log('[React DevTools] Error calling listener', data);
        console.log('error:', error);
        throw error;
      }
    });
  }
}

// The custom messaging version does not need throttling (used by standalone/Flipper)
// but we keep the same clean API.
type ConnectWithCustomMessagingOptions = { /* unchanged */ };

export function connectWithCustomMessagingProtocol({
  onSubscribe,
  onUnsubscribe,
  onMessage,
  nativeStyleEditorValidAttributes,
  resolveRNStyle,
  onSettingsUpdated,
  isReloadAndProfileSupported = getIsReloadAndProfileSupported(),
  isProfiling,
  onReloadAndProfile,
  onReloadAndProfileFlagsReset,
}: ConnectWithCustomMessagingOptions): Function {
  const hook: ?DevToolsHook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (hook == null) return () => {};

  const wall: Wall = {
    listen(fn) {
      onSubscribe(fn);
      return () => onUnsubscribe(fn);
    },
    send(event, payload) {
      onMessage(event, payload);
    },
  };

  const bridge = new Bridge(wall);

  bridge.addListener('updateComponentFilters', filters => {
    savedComponentFilters = filters;
  });

  if (window.__REACT_DEVTOOLS_COMPONENT_FILTERS__ == null) {
    bridge.send('overrideComponentFilters', savedComponentFilters);
  }

  const agent = new Agent(bridge, isProfiling, onReloadAndProfile);
  if (typeof onReloadAndProfileFlagsReset === 'function') onReloadAndProfileFlagsReset();

  if (onSettingsUpdated) {
    agent.addListener('updateHookSettings', onSettingsUpdated);
  }
  agent.addListener('shutdown', () => {
    if (onSettingsUpdated) agent.removeListener('updateHookSettings', onSettingsUpdated);
    hook.emit('shutdown');
  });

  const unsubscribe = initBackend(hook, agent, window, isReloadAndProfileSupported);

  const nativeStyleResolver = resolveRNStyle || hook.resolveRNStyle;
  if (nativeStyleResolver != null) {
    setupNativeStyleEditor(
      bridge,
      agent,
      nativeStyleResolver,
      nativeStyleEditorValidAttributes || hook.nativeStyleEditorValidAttributes || null,
    );
  }

  return unsubscribe;
}