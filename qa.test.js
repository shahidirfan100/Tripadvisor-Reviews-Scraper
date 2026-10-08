import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const actorDefinition = JSON.parse(readFileSync(new URL('./.actor/actor.json', import.meta.url), 'utf8'));
const schema = JSON.parse(readFileSync(new URL(`./.actor/${actorDefinition.input}`, import.meta.url), 'utf8'));
const source = readFileSync(new URL('./src/main.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '');
const localInput = JSON.parse(readFileSync(new URL('./storage/key_value_stores/default/INPUT.json', import.meta.url), 'utf8'));

async function runWithMocks(input, { failAfterFirstPage = false } = {}) {
    const pushes = [];
    const errors = [];
    const requests = [];
    const metadata = {};
    let exitCode;
    let pageRequests = 0;
    const actor = {
        init: async () => {},
        getInput: async () => input,
        openKeyValueStore: async () => ({ getValue: async () => null, setValue: async () => {} }),
        createProxyConfiguration: async () => undefined,
        pushData: async (items) => pushes.push(Array.from(items, (item) => ({ ...item }))),
        setValue: async (key, value) => { metadata[key] = value; },
        exit: async (options) => { exitCode = options.exitCode; },
    };
    class MockImpit {
        async fetch(url, options = {}) {
            requests.push({ url, options });
            if (options.method !== 'POST') {
                return { status: 200, ok: true, headers: {}, text: async () => '' };
            }
            pageRequests += 1;
            if (pageRequests > 1) assert.ok(pushes.length > 0, 'The previous page must be saved before another request');
            if (failAfterFirstPage && pageRequests > 1) throw new Error('Simulated upstream failure');
            const [{ variables }] = JSON.parse(options.body);
            const reviews = Array.from({ length: variables.limit }, (_, index) => ({
                id: String(variables.offset + index + 1),
                title: 'Fixture review',
                text: 'Fixture review text',
                rating: 5,
            }));
            return {
                status: 200,
                text: async () => JSON.stringify([{ data: {
                    ReviewsProxy_getReviewListPageForLocation: [{ reviews, totalCount: 1000 }],
                } }]),
            };
        }
    }
    const context = vm.createContext({
        Actor: actor,
        log: { info: () => {}, debug: () => {}, warning: () => {}, error: (message) => errors.push(message) },
        Impit: MockImpit,
        chromium: { launchPersistentContext: async () => { throw new Error('Unexpected browser launch'); } },
        process: { env: {} },
        URL,
        setTimeout: (callback) => { callback(); return 0; },
        clearTimeout: () => {},
    });
    await new vm.Script(`(async () => {\n${source}\n})()`).runInContext(context);
    return { pushes, errors, requests, metadata, exitCode };
}

test('Active schema has one matching search prefill/default and preserves control defaults', () => {
    const prefills = Object.entries(schema.properties).filter(([, value]) => Object.hasOwn(value, 'prefill'));
    assert.equal(prefills.length, 1);
    assert.equal(prefills[0][0], 'startUrls');
    assert.deepEqual(prefills[0][1].prefill, prefills[0][1].default);
    assert.ok(!(schema.required || []).includes('startUrls'));
    assert.equal(schema.properties.results_wanted.default, 20);
    assert.equal(schema.properties.max_pages.default, 5);
    assert.equal(schema.properties.sortBy.default, 'MOST_RECENT');
    assert.ok(schema.properties.proxyConfiguration);
    assert.deepEqual(localInput.startUrls, schema.properties.startUrls.prefill);
});

test('Store prefill input yields a nonempty dataset with default controls', async () => {
    const result = await runWithMocks({ startUrls: schema.properties.startUrls.prefill });
    assert.equal(result.exitCode, 0);
    assert.equal(result.pushes.flat().length, 20);
    assert.equal(result.metadata.RUN_INFO.requested_reviews, 20);
});

test('Caller URLs, filters, sort and limits are preserved and every page is saved promptly', async () => {
    const url = 'https://www.tripadvisor.com/Hotel_Review-g60763-d93425-Reviews-The_Plaza-New_York_City_New_York.html';
    const result = await runWithMocks({ startUrls: [url], results_wanted: 25, max_pages: 2,
        searchText: 'breakfast', lang: 'fr', sortBy: 'HIGHEST_RATED' });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.pushes.map((batch) => batch.length), [20, 5]);
    assert.ok(result.pushes.flat().every((record) => record.source_url === url));
    const [{ variables }] = JSON.parse(result.requests.find((request) => request.options.method === 'POST').options.body);
    assert.equal(variables.locationId, 93425);
    assert.equal(variables.sortBy, 'RATING');
    assert.deepEqual(variables.filters, [
        { axis: 'TEXT', selections: ['breakfast'] },
        { axis: 'LANGUAGE', selections: ['fr'] },
    ]);
});

test('API page limit is preserved', async () => {
    const result = await runWithMocks({ ...localInput, results_wanted: 50, max_pages: 1 });
    assert.equal(result.exitCode, 0);
    assert.equal(result.pushes.flat().length, 20);
    assert.equal(result.requests.filter((request) => request.options.method === 'POST').length, 1);
});

test('Partial output is saved before a later upstream failure', async () => {
    const result = await runWithMocks({ ...localInput, results_wanted: 25 }, { failAfterFirstPage: true });
    assert.equal(result.pushes.flat().length, 20);
    assert.equal(result.metadata.RUN_INFO.locations[0].status, 'failed');
});

test('Missing local input and invalid URLs fail with a logged error and nonzero exit', async () => {
    for (const input of [null, {}, { startUrls: ['https://www.tripadvisor.com/'] }]) {
        const result = await runWithMocks(input);
        assert.equal(result.exitCode, 1);
        assert.equal(result.pushes.length, 0);
        assert.equal(result.errors.length, 1);
    }
});

test('Platform-resolved schema defaults support omitted search input', async () => {
    const resolvedInput = Object.fromEntries(Object.entries(schema.properties)
        .filter(([, property]) => Object.hasOwn(property, 'default'))
        .map(([key, property]) => [key, property.default]));
    const result = await runWithMocks(resolvedInput);
    assert.equal(result.exitCode, 0);
    assert.equal(result.pushes.flat().length, 20);
});
