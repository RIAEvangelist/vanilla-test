# vanilla-test

This is a minimalist and pure js testing utility/suite/framework. It will work with ES6+ modules and common.js modules. The `VanillaTest` class is perfect for extending and very fast. There is no boilerplate, no fancy setup, just write your tests and run them from your npm test command.

npm info :  
![vanilla-test npm version](https://img.shields.io/npm/v/vanilla-test.svg) ![total npm downloads for vanilla-test](https://img.shields.io/npm/dt/vanilla-test.svg) ![monthly npm downloads for vanilla-test](https://img.shields.io/npm/dm/vanilla-test.svg)

GitHub info :  
![vanilla-test GitHub Release](https://img.shields.io/github/release/RIAEvangelist/vanilla-test.svg) ![GitHub license vanilla-test license](https://img.shields.io/github/license/RIAEvangelist/vanilla-test.svg) ![open issues for vanilla-test on GitHub](https://img.shields.io/github/issues/RIAEvangelist/vanilla-test.svg)

***Super light and fast*** Extensible pure JS testing for the win! Vanilla Test works in node, browsers, electron, anywhere JS runs.

## Core Test Methods
|method|args|returns|description|
|-|-|
|expects|`description` : a unique `string` test descriptor |`string` : numbered test descriptor|this sets up the current test|
|pass|`strict` : `boolean` throw if the test already passed or failed previously. This defaults to `false`|`string` : numbered test descriptor|call this if the test passes|
|fail|`strict` : `boolean` throw if the test already passed or failed previously. This defaults to `false`|`string` : numbered test descriptor|call this if the test fails|
|done||`string` : numbered test descriptor|Ends the test. If the test has not yet passed|failed, it will fail|
|report||report : `string` : `report`|report showing passed and failed tests|

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


try{
    test.expects('num1 to be a number');    
    test.is.number(num1);
}catch(err){
    console.log(`${err.name} : ${err.message}`);
    test.fail();
}
test.pass();
test.done();

try{
    test.expects('num2 to be a a number');    
    test.is.number(num2);
}catch(err){
    console.log(`${err.name} : ${err.message}`);
    test.fail();
}
test.pass();
test.done();

//this test should fail for demonstration purposes
try{
    test.expects('num1 == num2');    
    test.is.compare(num1,num2);
}catch(err){
    console.log(`test.is.compare(${num1},${num2}); : num1 and num2 were not equal`);
    test.fail();
}
test.pass();
test.done();


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

```
