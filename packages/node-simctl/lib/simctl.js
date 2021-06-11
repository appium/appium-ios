import { exec, SubProcess } from 'teen_process';
import { retryInterval } from 'asyncbox';
import { getLogger } from 'appium-logger';
import _ from 'lodash';


const log = getLogger('simctl');

async function simCommand (command:string, timeout:number, args:Array = [], env = {}, executingFunction = exec) {
  // run a particular simctl command
  args = ['simctl', command, ...args];
  // Prefix all passed in environment variables with 'SIMCTL_CHILD_', simctl
  // will then pass these to the child (spawned) process.
  env = _.defaults(_.mapKeys(env, function(value, key) {
    return `SIMCTL_CHILD_${key}`;
  }), process.env);

  try {
    return await executingFunction('xcrun', args, {timeout, env});
  } catch (e) {
    if (e.stderr) {
      log.errorAndThrow(`simctl error running '${command}': ${e.stderr.trim()}`);
    } else {
      log.errorAndThrow(e);
    }
  }
}

async function simExec (command:string, timeout:number, args:Array = [], env = {}) {
  return await simCommand(command, timeout, args, env, async (c, a, ob) => {
    return await exec(c, a, ob);
  });
}

async function simSubProcess (command:string, timeout:number, args:Array = [], env = {}) {
  return await simCommand(command, timeout, args, env, async (c, a, ob) => {
    return new SubProcess(c, a, ob);
  });
}

async function installApp (udid:string, appPath:string):void {
  await simExec('install', 0, [udid, appPath]);
}

async function removeApp (udid:string, bundleId:string):void {
  await simExec('uninstall', 0, [udid, bundleId]);
}

async function launch (udid:string, bundleId:string, tries:int = 5):void {
  await retryInterval(tries, 1000, async () => {
    await simExec('launch', 0, [udid, bundleId]);
  });
}

async function spawn (udid:string, executablePath:string, env = {}):void {
  return await simExec('spawn', 0, [udid, executablePath], env);
}

async function spawnSubProcess (udid:string, executablePath:string, env = {}):void {
  return await simSubProcess('spawn', 0, [udid, executablePath], env);
}

async function openUrl (udid:string, url:string):void {
  return await simExec('openurl', 0, [udid, url]);
}

async function shutdown (udid:string):void {
  await simExec('shutdown', 0, [udid]);
}

async function createDevice (name:string, deviceTypeId:string,
    runtimeId:string, timeout:int = 10000):void {
  let udid;
  try {
    let out = await simExec('create', 0, [name, deviceTypeId, runtimeId]);
    udid = out.stdout.trim();
  } catch (e) {
    if (e.stderr) {
      log.errorAndThrow(`Could not create simulator. Reason: ${e.stderr.trim()}`);
    } else {
      log.errorAndThrow(e);
    }

  }

  // make sure that it gets out of the "Creating" state
  let retries = parseInt(timeout / 1000, 10);
  await retryInterval(retries, 1000, async () => {
    let devices = await getDevices();
    for (let deviceArr of _.values(devices)) {
      for (let device of deviceArr) {
        if (device.udid === udid) {
          if (device.state === 'Creating') {
            // need to retry
            throw new Error('Device still being created');
          } else {
            // stop looking, we're done
            return;
          }
        }
      }
    }
  });

  return udid;
}

async function deleteDevice (udid:string):void {
  await simExec('delete', 0, [udid]);
}

async function eraseDevice (udid:string, timeout:int = 1000):void {
  let loopFn:Function = async () => {
    await simExec('erase', 10000, [udid]);
  };
  // retry erase with a sleep in between because it's flakey
  let retries = parseInt(timeout / 200, 10);
  await retryInterval(retries, 200, loopFn);
}

async function getDevices (forSdk:string = null):Object {
  // get the list of devices
  let {stdout} = await simExec('list', 0, ['devices']);

  // expect to get a listing like
  // -- iOS 8.1 --
  //     iPhone 4s (3CA6E7DD-220E-45E5-B716-1E992B3A429C) (Shutdown)
  //     ...
  // -- iOS 8.2 --
  //     iPhone 4s (A99FFFC3-8E19-4DCF-B585-7D9D46B4C16E) (Shutdown)
  //     ...
  // so, get the `-- iOS X.X --` line to find the sdk (X.X)
  // and the rest of the listing in order to later find the devices
  let deviceSectionRe:RegExp = /-- iOS (.+) --(\n    .+)*/mg;
  let matches:Array = [];
  let match:Object = deviceSectionRe.exec(stdout);

  // make an entry for each sdk version
  while (match !== null) {
    matches.push(match);
    match = deviceSectionRe.exec(stdout);
  }
  if (matches.length < 1) {
    log.errorAndThrow('Could not find device section');
  }

  // get all the devices for each sdk
  let devices:Object = {};
  for (match of matches) {
    let sdk:string = match[1];
    devices[sdk] = [];
    // split the full match into lines and remove the first
    for (let line:string of match[0].split('\n').slice(1)) {
      // a line is something like
      //    iPhone 4s (A99FFFC3-8E19-4DCF-B585-7D9D46B4C16E) (Shutdown)
      // retrieve:
      //   iPhone 4s
      //   A99FFFC3-8E19-4DCF-B585-7D9D46B4C16E
      //   Shutdown
      let lineRe:RegExp = /([^\s].+) \((\w+-.+\w+)\) \((\w+\s?\w+)\)/; // https://regex101.com/r/lG7mK6/3
      let lineMatch:Object = lineRe.exec(line);
      if (lineMatch === null) {
        throw new Error(`Could not match line: ${line}`);
      }
      // save the whole thing as ab object in the list for this sdk

      devices[sdk].push({
        name: lineMatch[1],
        udid: lineMatch[2],
        state: lineMatch[3],
        sdk,
      });
    }
  }

  // if a `forSdk` was passed in, return only the corresponding list
  if (forSdk) {
    if (!devices[forSdk]) {
      throw new Error(`Sdk '${forSdk}' was not in list of simctl sdks`);
    }
    return devices[forSdk];
  }

  // otherwise return all the sdk -> device mappings.
  return devices;
}

export { installApp, removeApp, launch, spawn, spawnSubProcess, openUrl, shutdown, createDevice,
         deleteDevice, eraseDevice, getDevices };
