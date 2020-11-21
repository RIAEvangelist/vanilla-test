# vanilla-test

This is a minimalist and pure js testing utility/suite/framework. It will work with ES6+ modules and common.js modules. The `VanillaTest` class is perfect for extending and very fast. There is no boilerplate, no fancy setup, just write your tests and run them from your npm test command.

npm info :  
![vanilla-test npm version](https://img.shields.io/npm/v/vanilla-test.svg) ![total npm downloads for vanilla-test](https://img.shields.io/npm/dt/vanilla-test.svg) ![monthly npm downloads for vanilla-test](https://img.shields.io/npm/dm/vanilla-test.svg)

GitHub info :  
![vanilla-test GitHub Release](https://img.shields.io/github/release/RIAEvangelist/vanilla-test.svg) ![GitHub license vanilla-test license](https://img.shields.io/github/license/RIAEvangelist/vanilla-test.svg) ![open issues for vanilla-test on GitHub](https://img.shields.io/github/issues/RIAEvangelist/vanilla-test.svg)

Build Info :  
Travis CI (linux,windows & Mac) : [![Build Status](https://travis-ci.org/RIAEvangelist/vanilla-test.svg?branch=master)](https://travis-ci.org/RIAEvangelist/vanilla-test) Appveyor CI : [![vanilla-test windows build status](https://ci.appveyor.com/api/projects/status/github/riaevangelist/vanilla-test?branch=master&svg=true)](https://ci.appveyor.com/project/RIAEvangelist/vanilla-test/history)

***Super light and fast*** Extensible pure JS testing for the win! Vanilla Test works in node, browsers, electron, anywhere JS runs.

## Core Test Methods
|method|args|returns|description|
|-|-|-|-|
|expects|`description` : a unique `string` test descriptor |`string` : numbered test descriptor|this sets up the current test|
|pass|`strict` : `boolean` throw if the test already passed or failed previously. This defaults to `false`|`string` : numbered test descriptor|call this if the test passes|
|fail|`strict` : `boolean` throw if the test already passed or failed previously. This defaults to `false`|`string` : numbered test descriptor|call this if the test fails|
|done||`string` : numbered test descriptor|Ends the test. If the test has not yet passed|failed, it will fail|
|report|`CI`:`boolean` defaults to `true`. This will try to exit after reporting. Letting your CI know the test is complete in node, or return the number of failures in the browser. If set to `false`, it will return the data used to report for you to modify etc. could be useful for extensions, beautification, or other integrations.|report : `string` : `report`|report showing passed and failed tests. This will also communicate with your CI like circle CI or Travis CI|

## Strong Type Checking
`vanilla-test` uses the `strong-type` class which provides methods to test ***all*** the built in js primatives, objects, classes, and even fancy things like async functions and generators.

[full strong-type documentation](https://github.com/RIAEvangelist/strong-type)

The `strong-type` methods are available on the `.is` method.

```js

import VanillaTest from './node_modules/vanilla-test/index.js';

//not actually running tests in this example, just demonstrating
//strong type checking

const test=new VanillaTest;

test.is.string('hello');

test.is.number(1);

test.is.int8Array(new Int8Array(3));

test.is.asyncFunction(async function(){});

test.is.asyncGeneratorFunction(async function*(){});


function* genFunc(){}
let generator=genFunc();

test.is.generatorFunction(genFunc);

test.is.generator(generator);


```

## Basic Examples

These basic examples should be enough to get you started testing right away.

```js
//import with relative paths to shim for browser
//this way the same code will work on the web as it does in node
//litteraly the same file without even transpiling,  
//but you can transpile if you want.
import VanillaTest from './node_modules/vanilla-test/index.js';

const test=new VanillaTest;

//setup
const num1=1;
const num2=2;
function sum(a,b){
    return a+b;
}


// 1) expects num1 to be a number
try{
    test.expects('num1 to be a number');    
    test.is.number(num1);
}catch(err){
    console.log(`${err.name} : ${err.message}`);
    test.fail();
}
test.pass();
test.done();



// 2) expects num2 to be a a number
try{
    test.expects('num2 to be a a number');    
    test.is.number(num2);
}catch(err){
    console.log(`${err.name} : ${err.message}`);
    test.fail();
}
test.pass();
test.done();



// 3) expects num1 == num2
//this test should fail for demonstration purposes
try{
    test.expects('num1 == num2');    
    test.compare(num1,num2);
}catch(err){
    console.log(`test.compare(${num1},${num2}); : num1 and num2 were not equal`);
    test.fail();
}
test.pass();
test.done();



// 4) expects num1 == num2
try{
    test.expects('sum(num1,num2) to be equal to num1+num2');    

    test.compare(
        sum(num1,num2),
        num1+num2
    );
}catch(err){
    console.log(`sum(${num1},${num2}); was not equal to num1+num2`);
    test.fail();
}
test.pass();
test.done();



// 5) expects A TypeError when type checks fail
try{
    test.expects('A TypeError when type checks fail');    
    test.boolean(new Array(2));
}catch(err){
    try{
        test.is.typeError(err);
    }catch{
        console.log(`${err.name} : ${err.message}`);
        test.pass();
    }
    test.fail();
}
test.fail();
test.done();



//Lets take a look at the test results and let our CI know 
// that the tests have completed and passed or failed
test.report();


```

## Node example

run `node ./example/node/basic.js`

![screen shot of vanilla-test example on node](https://raw.githubusercontent.com/RIAEvangelist/vanilla-test/main/example/img/vanilla-test-node-report.PNG)

## Browser example

run `npm start` then go to [the local test](http://localhost:8000/example/web/index.html). It actually imports the node test into the browser and runs it, same exact file, no transpiling or custom code for the browser. If you want to transpile though, you can.

#### Chrome

![screen shot of vanilla-test example on chrome](https://raw.githubusercontent.com/RIAEvangelist/vanilla-test/main/example/img/vanilla-test-chrome-report.PNG)

#### Edge

![screen shot of vanilla-test example on edge](https://raw.githubusercontent.com/RIAEvangelist/vanilla-test/main/example/img/vanilla-test-edge-report.PNG)