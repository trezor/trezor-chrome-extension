/* @flow */

"use strict";

import Link from "trezor-link";
import hidTransport from "trezor-link-chrome-hid";
import UdpTransport from "trezor-link-chrome-udp";

import type {AcquireInput, TrezorDeviceInfoWithSession as LinkDevice} from "trezor-link";

import * as storage from "./chrome/storage";
import {manifest} from "./chrome/platformInfo";

type MessageFromTrezor = {type: string, message: Object};
type StatusInfo = {version: string, configured: boolean}

type TrezorDeviceInfo = {
  path: string;
  vendor: number;
  product: number;
  serialNumber: number; // always 0
  session: ?string; // might be null/undefined
}

const TREZOR_VENDOR_ID: number = 0x534c;
const TREZOR_PRODUCT_ID: number = 0x0001;

const udpTransport = new UdpTransport(3);

const link = new Link(Link.combineTransports({"hid": hidTransport, "udp": udpTransport}));

// when we try to read messages and it's null, we look into storage
// if it's not saved. If it is saved, we try to configure again
async function messagesReload(): Promise<void> {
  const hasMessages = await link.hasMessages();
  if (hasMessages) {
    return;
  }
  let savedConfigure: string = "";
  try {
    savedConfigure = await storage.get("savedConfigure");
  } catch (e) {
    throw new Error("No protocol definition, call configure.");
  }
  await configure(savedConfigure);
}

async function ping() {
  return "pong";
}

function convertDevices(devices: Array<LinkDevice>): Array<TrezorDeviceInfo> {
  return devices.map(device => {
    return {
      ...device,
      vendor: TREZOR_VENDOR_ID,
      product: TREZOR_PRODUCT_ID,
      serialNumber: 0,
    };
  });
}

async function enumerate(): Promise<Array<TrezorDeviceInfo>> {
  return convertDevices(await link.enumerate());
}

async function listen(previous: mixed): Promise<Array<TrezorDeviceInfo>> {
  let convertedPrevious: ?Array<LinkDevice> = null;
  if (previous != null) {
    if (typeof previous === "object") {
      if (previous instanceof Array) {
        convertedPrevious = previous.map((d: mixed): LinkDevice => {
          if (typeof d !== "object" || d == null) {
            throw new Error("Device is not an object");
          }
          if (typeof d.path !== "string") {
            throw new Error("Device path is strange");
          }
          const path: string = d.path;
          let session: ?string = null;
          if (d.session != null) {
            if (typeof d.session !== "string") {
              throw new Error("Device session is strange");
            }
            session = d.session;
          }
          const r: LinkDevice = {path, session};
          return r;
        });
      }
    }
  }
  return convertDevices(await link.listen(convertedPrevious));
}

async function acquire(input: mixed): Promise<{session: string}> {
  let acquireInput: AcquireInput = "";
  if (typeof input === "string") {
    acquireInput = input;
  } else if (typeof input === "object" && input != null) {
    if (typeof input.path !== "string") {
      throw new Error("Device path is strange.");
    }
    const path: string = input.path;
    let previous: ?string = null;
    if (input.previous != null) {
      if (typeof input.previous !== "string") {
        throw new Error("Device session is strange.");
      }
      previous = input.previous;
    }
    acquireInput = {path, previous};
  }
  const session = await link.acquire(acquireInput);
  return {session};
}

async function release(input: mixed): Promise<string> {
  if (typeof input !== "string") {
    throw new Error("Device session is strange.");
  }
  await link.release(input);
  return "Success";
}

async function udevStatus(): Promise<string> {
  const hasError: boolean = await hidTransport.showUdevError();
  return hasError ? "display" : "hide";
}

async function call(input: mixed): Promise<MessageFromTrezor> {
  if (typeof input !== "object" || input == null) {
    throw new Error("Input is not an object");
  }
  if (typeof input.id !== "string") {
    throw new Error("Session is strange.");
  }
  if (typeof input.type !== "string") {
    throw new Error("Type is not a string.");
  }
  if (typeof input.message !== "object" || input.message == null) {
    throw new Error("Message is not an object.");
  }
  const id: string = input.id;
  const type: string = input.type;
  const message: Object = input.message;
  await messagesReload();
  return await link.call(id, type, message);
}

async function configure(input: mixed): Promise<string> {
  if (typeof input !== "string") {
    throw new Error("Configure input is strange.");
  }
  const body: string = input;
  await storage.set(body);
  await link.configure(body);
  return "Success";
}

async function _version(): Promise<string> {
  const version = (await manifest()).version;
  if (version == null) {
    throw new Error("Manifest doesn't have a version!");
  }
  return version;
}

async function _configured(): Promise<boolean> {
  try {
    await messagesReload();
    return true;
  } catch (e) {
    return false;
  }
}

async function info(): Promise<StatusInfo> {
  return {
    version: await _version(),
    configured: await _configured(),
  };
}

const responseFunctions = {
  ping,
  enumerate,
  listen,
  acquire,
  release,
  udevStatus,
  call,
  configure,
  info,
};

function handleMessage(request: Object, sender: ChromeMessageSender, sendResponse: (response: Object) => void): boolean {
  if (process.env.NODE_ENV === "debug") {
    console.log("Message arrived: ", request);
  }

  const responseFunction = (responseFunctions[request.type])
    ? responseFunctions[request.type]
    : () => {
      throw new Error("No function defined for " + request.type);
    };

  const nonThrowingResponse = (body) => {
    try {
      return responseFunction(body);
    } catch (e) {
      return Promise.reject(e);
    }
  };

  nonThrowingResponse(request.body).then((responseBody) => {
    if (process.env.NODE_ENV === "debug") {
      console.log("Response sent: ", JSON.parse(JSON.stringify(responseBody)), JSON.parse(JSON.stringify(request)));
    }

    sendResponse({
      type: "response",
      body: responseBody,
    });
  }).catch((error) => {
    if (process.env.NODE_ENV === "debug") {
      console.log("Error sent: ", error, JSON.parse(JSON.stringify(request)));
    }

    sendResponse({
      type: "error",
      message: error.message || error,
    });
  });

  // "return true" is necessary for asynchronous message passing,
  // don't remove it!
  return true;
}

chrome.runtime.onMessage.addListener(handleMessage);
chrome.runtime.onMessageExternal.addListener(handleMessage);
let windowOpen: boolean = false;

chrome.app.runtime.onLaunched.addListener(() => {
  if (!windowOpen) {
    chrome.app.window.create("management/index.html", {
      "innerBounds": {
        "width": 774,
        "height": 774,
      },
    }, (newWindow) => {
      windowOpen = true;
      newWindow.onClosed.addListener(() => {
        windowOpen = false;
      });
    });
  }
});

storage.get("udp").then((udpSerialized) => {
  const udpStorage = JSON.parse(udpSerialized);
  if (udpStorage instanceof Array) {
    udpTransport.setPorts(udpStorage);
  }
});

window.setUdp = function (ports: Array<number>) {
  storage.set("udp", JSON.stringify(ports));
  udpTransport.setPorts(ports);
  console.log("Ports added", ports);
};
