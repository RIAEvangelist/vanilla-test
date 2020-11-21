# Emulated node_modules
This folder is here just because we are inside the `vanilla-test` module and we can not properly emulate an app's node_modules without going a dir above the `index.js` which is already in the root of this server.

For development purposes, there is an npm script that will echo out the commands to copy the relevant files after you run an `npm i` in the root of the module. This will ensure that the examples always have the current version of `index.js` and the dependancy `strong-type`

## Node example

run `node ./example/node/basic.js`

![screen shot of vanilla-test example on node](https://raw.githubusercontent.com/RIAEvangelist/vanilla-test/main/example/img/vanilla-test-node-report.PNG)

## Browser example

run `npm start` then go to [the local test](http://localhost:8000/example/web/index.html). It actually imports the node test into the browser and runs it, same exact file, no transpiling or custom code for the browser. If you want to transpile though, you can.

#### Chrome

![screen shot of vanilla-test example on chrome](https://raw.githubusercontent.com/RIAEvangelist/vanilla-test/main/example/img/vanilla-test-chrome-report.PNG)

#### Edge

![screen shot of vanilla-test example on edge](https://raw.githubusercontent.com/RIAEvangelist/vanilla-test/main/example/img/vanilla-test-edge-report.PNG)