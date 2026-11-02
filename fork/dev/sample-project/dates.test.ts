// Run with: node --test
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { daysBetween, formatDate, parseDate } from './src/dates.ts';

test('parseDate reads the month correctly', () => {
	assert.equal(parseDate('2026-01-31').getMonth(), 0);
});

test('formatDate pads month and day', () => {
	assert.equal(formatDate(new Date(2026, 0, 5)), '2026-01-05');
});

test('daysBetween counts whole days', () => {
	assert.equal(daysBetween(new Date(2026, 0, 1), new Date(2026, 0, 31)), 30);
});
