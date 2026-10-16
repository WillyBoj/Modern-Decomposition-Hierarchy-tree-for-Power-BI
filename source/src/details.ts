/*
 *  Hierarchy Explorer – details for a node.
 *  Pure functions with no DOM or Power BI dependencies so they can be unit tested.
 */

"use strict";

export interface DetailColumn {
    /** Field name shown as the label. */
    name: string;
    /** Column index in the table rows. */
    index: number;
    /** Converts a raw cell value to display text, or null for blanks. */
    format: (value: unknown) => string | null;
}

export interface DetailEntry {
    label: string;
    /** Up to MAX_SHOWN distinct values, in first-seen order. */
    values: string[];
    /** Number of distinct non-blank values (capped at MAX_COUNTED). */
    distinct: number;
    /** True when there were more distinct values than MAX_COUNTED. */
    more: boolean;
}

const MAX_SHOWN = 3;
const MAX_COUNTED = 999;

/**
 * Collect the distinct values of each detail column across the given rows.
 * A leaf such as a person usually has one value per field; a parent such as a team
 * collects the values of everyone beneath it.
 */
export function collectDetails(rows: ReadonlyArray<ReadonlyArray<unknown>>, rowIndexes: number[], columns: DetailColumn[]): DetailEntry[] {
    return columns.map((column) => {
        const seen = new Set<string>();
        const values: string[] = [];
        let more = false;
        for (const r of rowIndexes) {
            const text = column.format(rows[r]?.[column.index]);
            if (text === null || seen.has(text)) {
                continue;
            }
            if (seen.size >= MAX_COUNTED) {
                more = true;
                break;
            }
            seen.add(text);
            if (values.length < MAX_SHOWN) {
                values.push(text);
            }
        }
        return { label: column.name, values, distinct: seen.size, more };
    });
}

/** One-line summary of a detail: the value, a short list, or how many different values there are. */
export function summarizeDetail(entry: DetailEntry): string {
    if (entry.distinct === 0) {
        return "–";
    }
    if (entry.distinct === 1) {
        return entry.values[0];
    }
    if (entry.distinct <= MAX_SHOWN) {
        return entry.values.join(", ");
    }
    return `${entry.distinct}${entry.more ? "+" : ""} different values`;
}

/** Two-letter initials from a name: "Ada Quillmere" → "AQ", "Finance" → "FI", "Plan-301 North" → "PN". */
export function initialsOf(name: string): string {
    const words = name
        .split(/[\s\-_.,/()&]+/)
        .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
        .filter((w) => w.length > 0);
    if (words.length === 0) {
        return "?";
    }
    const lettersFirst = words.filter((w) => /^\p{L}/u.test(w));
    const pool = lettersFirst.length > 0 ? lettersFirst : words;
    if (pool.length === 1) {
        return Array.from(pool[0]).slice(0, 2).join("").toUpperCase();
    }
    const first = Array.from(pool[0])[0];
    const last = Array.from(pool[pool.length - 1])[0];
    return (first + last).toUpperCase();
}

/** True for values that should open in a browser tab when clicked. */
export function isWebLink(text: string): boolean {
    return /^https:\/\/[^\s]+$/i.test(text);
}
