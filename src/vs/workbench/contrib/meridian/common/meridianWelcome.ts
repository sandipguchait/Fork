/*---------------------------------------------------------------------------------------------
 *  Meridian. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';

// The Welcome's greeting: "Good evening, Sandip."

/** "Good morning", "Good afternoon" or "Good evening", by the hour. */
export function greetingFor(hour: number): string {
	if (hour >= 5 && hour < 12) {
		return localize('meridian.goodMorning', "Good morning");
	}
	if (hour >= 12 && hour < 18) {
		return localize('meridian.goodAfternoon', "Good afternoon");
	}
	return localize('meridian.goodEvening', "Good evening");
}

/** The first name from "Sandip Guchait" or "sandip", capitalized. */
export function firstName(name: string | undefined): string | undefined {
	const first = name?.trim().split(/[\s._-]+/)[0];
	return first ? first[0].toUpperCase() + first.slice(1) : undefined;
}
