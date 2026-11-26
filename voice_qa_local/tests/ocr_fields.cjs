const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sandbox = vm.createContext({});
const script = fs.readFileSync(path.join(__dirname,'..','figure_rag.js'),'utf8');
vm.runInContext(script+';globalThis.lookup=FigureRag.printedField;',sandbox);
const {lookup} = sandbox;
const image = (value,source='sensor-a.png') => ({
  kind:'figure',source,ocr:{lines:[{text:'PRESSURE: '+value}]}
});
const images = [image('37 kPa'),image('52 kPa','sensor-b.png')];

assert.equal(lookup(images.slice(0,1),'图上的 PRESSURE 是多少？').text,'OCR 识别为 37 kPa。');
assert.match(lookup(images,'图片上的 PRESSURE 的值是多少？').text,/多个读数/);
assert.equal(lookup(images,'sensor-b.png 上的 PRESSURE 是多少？').text,'OCR 识别为 52 kPa。');
assert.equal(lookup(images,'PRESSURE 是不是 37 kPa？'),null);
assert.equal(lookup(images,'LOWPRESSURE 的值是多少？'),null);
assert.equal(lookup(images,'STATUS 的值是多少？'),null);
assert.equal(lookup([{ocr:{lines:[{text:'工 作 压 力：0.8 MPa'}]}}],
  '工作压力是多少？').text,'OCR 识别为 0.8 MPa。');
console.log('OCR field lookup 7 checks passed');
