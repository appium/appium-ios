#!/usr/bin/env node

var fs = require('fs')
  , path = require('path');


function waitForDeps (cb) {
  // see if we can import the necessary code
  // try it a ridiculous (but finite) number of times
  var i = 0;
  function check () {
    i++;
    try {
      require('./build-js/lib/install');
      cb();
    } catch (err) {
      if (err.message.indexOf("Cannot find module './build-js/lib/install'") !== -1) {
        console.warn('Project does not appear to built yet. Please run `gulp transpile` first.');
        return cb('Could not install module: ' + err);
      }
      console.warn('Error trying to install ios-test-app. Waiting and trying again.', err.message);
      if (i <= 200) {
        setTimeout(check, 1000);
      } else {
        cb('Could not install module: ' + err);
      }
    }
  }
  check();
}

if (require.main === module) {
  // check if cur dir exists
  var installScript = path.resolve(__dirname, 'build-js', 'lib', 'install.js');
  waitForDeps(function (err) {
    if (err) {
      console.warn("Unable to import install script. Re-run `install ios-test-app` manually.");
      process.exit(1);
    }
    fs.stat(installScript, function (err) {
      if (err) {
        console.warn("NOTE: Run 'gulp transpile' before using");
        return;
      }
      require('./build-js/lib/install').install().catch(function (err) {
        console.error(err.stack ? err.stack : err);
        process.exit(1);
      });
    });
  });
}
