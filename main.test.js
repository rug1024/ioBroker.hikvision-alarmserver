'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sinon = require('sinon');

// Real adapter code and XML/multipart parsers; mocked ioBroker, HTTP and canvas.
function createAdapter(canvasModule = {}) {
    class Adapter extends EventEmitter {
        constructor() {
            super();
            this.config = { ...require('./io-package.json').native };
            this.log = { level: 'info' };
            for (const level of ['debug', 'info', 'warn', 'error']) this.log[level] = sinon.spy();
            this.FORBIDDEN_CHARS = /[^._\-/ :!#$%&()+=@^{}|~\p{Ll}\p{Lu}\p{Nd}]+/gu;
            for (const method of ['setStateAsync', 'setStateChangedAsync', 'setObjectNotExistsAsync']) {
                this[method] = sinon.stub().resolves();
            }
            this.setState = sinon.spy();
            this.getForeignObjectsAsync = sinon.stub().resolves({});
            this.setTimeout = sinon.stub().callsFake((fn, delay, ...args) => ({ fn, delay, args }));
            this.clearTimeout = sinon.spy();
        }
    }
    const server = new EventEmitter();
    server.listen = sinon.spy();
    server.close = sinon.spy();
    let requestHandler;
    const moduleMock = { exports: {} };
    const loadCanvas = sinon.stub().callsFake(() => {
        if (canvasModule instanceof Error) throw canvasModule;
        return canvasModule;
    });
    const mockRequire = (id) => {
        if (id === '@iobroker/adapter-core') return { Adapter, getAbsoluteInstanceDataDir: () => '/unused-test-data' };
        if (id === 'canvas') return loadCanvas();
        if (id === 'node:http') return { createServer: (handler) => { requestHandler = handler; return server; } };
        return require(id);
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8'), {
        module: moduleMock, require: mockRequire, Buffer,
    }, { filename: 'main.js' });
    return { adapter: moduleMock.exports(), server, loadCanvas, requestHandler: () => requestHandler };
}

const xml = (date = '2026-09-28T18:00:00Z') => Buffer.from(
    '<EventNotificationAlert><macAddress>aa:bb:cc:dd:ee:ff</macAddress>' +
    '<eventType>fielddetection</eventType><dateTime>' + date + '</dateTime>' +
    '<DetectionRegionList><DetectionRegionEntry><detectionTarget>human</detectionTarget>' +
    '</DetectionRegionEntry></DetectionRegionList></EventNotificationAlert>'
);

function multipartBody(xmlBuffer) {
    return Buffer.concat([
        Buffer.from('--test-boundary\r\nContent-Disposition: form-data; name="event"; filename="event.xml"\r\nContent-Type: application/xml\r\n\r\n'),
        xmlBuffer,
        Buffer.from('\r\n--test-boundary\r\nContent-Disposition: form-data; name="image"; filename="image.jpg"\r\nContent-Type: image/jpeg\r\n\r\n'),
        Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
        Buffer.from('\r\n--test-boundary--\r\n'),
    ]);
}

describe('Alarm event handling', () => {
    let adapter;
    beforeEach(() => { adapter = createAdapter().adapter; });

    it('sets fielddetection and clears it after the configured timeout', async () => {
        await adapter.handlePayload({ 'content-type': 'application/xml' }, xml());
        const id = 'aabbccddeeff.fielddetection';
        sinon.assert.calledWith(adapter.setStateChangedAsync, id, true, true);
        const timer = adapter.stateTimers[id];
        assert.equal(timer.delay, 5000);
        timer.fn(...timer.args);
        sinon.assert.calledWith(adapter.setState, id, false, true);
        assert.equal(adapter.stateTimers[id], undefined);
    });

    it('refreshes the timeout on another fielddetection event', async () => {
        await adapter.handlePayload({ 'content-type': 'application/xml' }, xml());
        const id = 'aabbccddeeff.fielddetection';
        const first = adapter.stateTimers[id];
        await adapter.handlePayload({ 'content-type': 'application/xml' }, xml());
        sinon.assert.calledWith(adapter.clearTimeout, first);
        assert.notEqual(adapter.stateTimers[id], first);
    });

    it('preserves optional human detection target state IDs', async () => {
        adapter.config.useDetectionTargets = true;
        await adapter.handlePayload({ 'content-type': 'application/xml' }, xml());
        sinon.assert.calledWith(adapter.setStateChangedAsync, 'aabbccddeeff.human.fielddetection', true, true);
    });

    for (const testCase of [
        { useChannels: false, useDetectionTargets: true, name: 'human', id: 'human', statePath: 'human' },
        { useChannels: true, useDetectionTargets: false, name: 'Front.Door', id: 'Front_Door', statePath: 'Front.Door' },
        { useChannels: true, useDetectionTargets: true, name: 'Front.Door.human', id: 'Front_Door_human', statePath: 'Front.Door.human' },
    ]) {
        it(`creates ${testCase.name} without the deprecated channel API and preserves existing IDs`, async () => {
            adapter.config.useChannels = testCase.useChannels;
            adapter.config.useDetectionTargets = testCase.useDetectionTargets;
            const body = Buffer.from(xml().toString().replace(
                '</EventNotificationAlert>', '<channelName>Front.Door</channelName></EventNotificationAlert>'
            ));
            await adapter.handlePayload({ 'content-type': 'application/xml' }, body);
            sinon.assert.calledWith(adapter.setObjectNotExistsAsync, 'aabbccddeeff.' + testCase.id,
                sinon.match({ type: 'channel', common: { name: testCase.name }, native: {} }));
            sinon.assert.calledWith(adapter.setStateChangedAsync, 'aabbccddeeff.' + testCase.statePath + '.fielddetection', true, true);
        });
    }

    for (const body of ['<broken>', '<EventNotificationAlert/>']) {
        it(`rejects invalid event XML: ${body}`, async () => {
            await adapter.handlePayload({ 'content-type': 'application/xml' }, Buffer.from(body));
            sinon.assert.notCalled(adapter.setStateChangedAsync);
            sinon.assert.called(adapter.log.error);
        });
    }

    it('uses receipt time for an invalid camera timestamp', async () => {
        const ctx = {};
        const before = Date.now();
        await adapter.handleXml(ctx, xml('invalid-date'));
        assert.ok(ctx.ts.getTime() >= before && ctx.ts.getTime() <= Date.now());
        assert.match(ctx.periodPath, /^\d{8}$/);
    });

    for (const saveImages of [false, true]) {
        for (const sendImages of [false, true]) {
            it(`handles multipart images with save=${saveImages}, send=${sendImages}`, async () => {
                adapter.config.saveImages = saveImages;
                adapter.sendImageConfig = { instance: sendImages ? 'telegram.0' : '' };
                adapter.handleJpegPart = sinon.stub().resolves();
                await adapter.handlePayload(
                    { 'content-type': 'multipart/form-data; boundary=test-boundary' }, multipartBody(xml())
                );
                assert.equal(adapter.handleJpegPart.callCount, saveImages || sendImages ? 1 : 0);
                sinon.assert.calledWith(adapter.setStateChangedAsync, 'aabbccddeeff.fielddetection', true, true);
            });
        }
    }

    it('skips multipart images when the XML event is invalid', async () => {
        adapter.config.saveImages = true;
        adapter.handleJpegPart = sinon.stub().resolves();
        await adapter.handlePayload(
            { 'content-type': 'multipart/form-data; boundary=test-boundary' }, multipartBody(Buffer.from('<broken>'))
        );
        sinon.assert.notCalled(adapter.handleJpegPart);
    });

    it('expires a connected client with the correct adapter context', async () => {
        adapter.clientConnected('aabbccddeeff');
        const timer = adapter.clientTimers.aabbccddeeff;
        const callback = timer.fn;
        callback(...timer.args);
        await Promise.resolve();
        assert.equal(adapter.clientTimers.aabbccddeeff, undefined);
        sinon.assert.calledWith(adapter.setStateAsync, 'info.connection', '', true);
    });

    it('clears an active alarm and calls the unload callback once', async () => {
        await adapter.handlePayload({ 'content-type': 'application/xml' }, xml());
        const callback = sinon.spy();
        await adapter.onUnload(callback);
        sinon.assert.calledWith(adapter.setStateAsync, 'aabbccddeeff.fielddetection', false, true);
        sinon.assert.calledOnce(callback);
        assert.equal(Object.keys(adapter.stateTimers).length, 0);
        assert.equal(Object.keys(adapter.clientTimers).length, 0);
    });

    it('still calls the unload callback when cleanup fails', async () => {
        adapter.server = { close: () => { throw new Error('close failed'); } };
        const callback = sinon.spy();
        await adapter.onUnload(callback);
        sinon.assert.calledOnce(callback);
        sinon.assert.called(adapter.log.error);
    });
});

describe('HTTP request handling', () => {
    for (const fails of [false, true]) {
        it(`acknowledges a POST after ${fails ? 'failed' : 'successful'} asynchronous processing`, async () => {
            const fixture = createAdapter();
            const { adapter } = fixture;
            await adapter.onReady();
            let finish;
            adapter.handlePayload = sinon.stub().returns(new Promise((resolve, reject) => {
                finish = () => fails ? reject(new Error('parser failed')) : resolve();
            }));
            const request = new EventEmitter();
            Object.assign(request, { method: 'POST', url: '/', headers: { 'content-type': 'application/xml' } });
            const response = { statusCode: 503, end: sinon.spy() };
            fixture.requestHandler()(request, response);
            request.emit('data', xml());
            // Await the listener directly so a rejected promise fails the test.
            const completed = request.listeners('end')[0]();
            sinon.assert.notCalled(response.end);
            finish();
            await completed;
            assert.equal(response.statusCode, 200);
            sinon.assert.calledOnce(response.end);
            if (fails) sinon.assert.calledWithMatch(adapter.log.error, 'Failed to handle alarm request:');
        });
    }

    it('handles a request stream error without an uncaught error event', async () => {
        const fixture = createAdapter();
        await fixture.adapter.onReady();
        const request = new EventEmitter();
        Object.assign(request, { method: 'POST', url: '/', headers: {} });
        fixture.requestHandler()(request, { end: sinon.spy() });
        request.emit('error', new Error('connection reset'));
        sinon.assert.calledWithMatch(fixture.adapter.log.warn, 'HTTP request error:');
    });
});

describe('Optional image annotation', () => {
    it('starts and processes field detection without loading canvas in motion-only mode', async () => {
        const { adapter, loadCanvas } = createAdapter(new Error('canvas not installed'));
        await adapter.onReady();
        await adapter.handlePayload({ 'content-type': 'application/xml' }, xml());
        sinon.assert.notCalled(loadCanvas);
        sinon.assert.calledWith(adapter.setStateChangedAsync, 'aabbccddeeff.fielddetection', true, true);
        sinon.assert.notCalled(adapter.log.warn);
    });

    it('does not load canvas when annotation is disabled', async () => {
        const { adapter, loadCanvas } = createAdapter(new Error('canvas not installed'));
        adapter.config.saveImages = true;
        adapter.config.annotateImages = false;
        await adapter.onReady();
        sinon.assert.notCalled(loadCanvas);
    });

    for (const target of ['saveImages', 'sendImageInstance']) {
        it(`loads canvas when annotation and ${target} are enabled`, async () => {
            const canvasModule = {};
            const { adapter, loadCanvas } = createAdapter(canvasModule);
            adapter.config[target] = target === 'saveImages' ? true : 'telegram.0';
            await adapter.onReady();
            sinon.assert.calledOnce(loadCanvas);
            assert.equal(adapter.canvas, canvasModule);
        });
    }

    it('saves and forwards original images if the native canvas module fails to load', async () => {
        const { adapter, loadCanvas } = createAdapter(new Error('native module load failed'));
        adapter.config.saveImages = true;
        adapter.config.sendImageInstance = 'telegram.0';
        await adapter.onReady();
        adapter.dumpFile = sinon.stub().resolves();
        adapter.checkAndSendTo = sinon.stub().resolves();
        const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
        const ctx = { fileBase: 'test' };
        await adapter.handleJpegPart(ctx, { filename: 'image.jpg', data: image });
        sinon.assert.calledOnce(loadCanvas);
        sinon.assert.calledOnce(adapter.log.warn);
        sinon.assert.calledWith(adapter.dumpFile, ctx, image, 'test-image.jpg');
        sinon.assert.calledWith(adapter.checkAndSendTo, adapter.sendImageConfig, ctx, image);
    });
});
