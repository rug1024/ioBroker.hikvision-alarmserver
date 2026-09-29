'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const { tests } = require('@iobroker/testing');

function postEvent(body) {
    return new Promise((resolve, reject) => {
        const request = http.request({
            hostname: '127.0.0.1', port: 8089, method: 'POST', path: '/',
            headers: { 'content-type': 'application/xml' },
        }, response => {
            response.resume();
            response.on('end', () => resolve(response.statusCode));
        });
        request.on('error', reject);
        request.setTimeout(5000, () => request.destroy(new Error('Alarm request timed out')));
        request.end(body);
    });
}

async function waitForState(harness, id, value) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        const state = await harness.states.getStateAsync(id);
        if (state && state.val === value && state.ack === true) return;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail(`State ${id} did not become ${value}`);
}

tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('Field detection over HTTP', getHarness => {
            it('processes a camera event, clears the alarm, and survives malformed XML', async function () {
                this.timeout(30000);
                const harness = getHarness();
                await harness.changeAdapterConfig('hikvision-alarmserver', {
                    native: { bind: '127.0.0.1', port: 8089, alarmTimeout: 1000, saveImages: false, sendImageInstance: '' },
                });
                await harness.startAdapterAndWait();
                const body = '<EventNotificationAlert><macAddress>aa:bb:cc:dd:ee:ff</macAddress>' +
                    '<eventType>fielddetection</eventType><dateTime>2026-09-28T18:00:00Z</dateTime>' +
                    '</EventNotificationAlert>';
                // The alive state can arrive before the HTTP listener is ready.
                let status;
                for (let attempt = 0; attempt < 50; attempt++) {
                    try {
                        status = await postEvent(body);
                        break;
                    } catch (err) {
                        if (err.code !== 'ECONNREFUSED' || attempt === 49) throw err;
                        await new Promise(resolve => setTimeout(resolve, 100));
                    }
                }
                assert.equal(status, 200);
                const id = 'hikvision-alarmserver.0.aabbccddeeff.fielddetection';
                await waitForState(harness, id, true);
                await waitForState(harness, id, false);
                assert.equal(await postEvent('<broken>'), 200);
                assert.equal(await postEvent(body), 200);
                await waitForState(harness, id, true);
                await harness.stopAdapter();
                await waitForState(harness, id, false);
            });
        });
    },
});
