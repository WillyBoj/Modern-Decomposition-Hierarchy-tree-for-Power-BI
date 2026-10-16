/*
 *  Hierarchy Explorer – value formatting and text measurement helpers.
 *  Uses only the browser's built-in Intl and canvas APIs.
 */

"use strict";

export interface ValueFormatter {
    /** Short form for node cards, for example 1.2K. */
    compact(value: number): string;
    /** Full precision form for tooltips. */
    full(value: number): string;
}

function safeNumberFormat(locale: string | undefined, options: Intl.NumberFormatOptions): Intl.NumberFormat {
    try {
        return new Intl.NumberFormat(locale, options);
    } catch {
        return new Intl.NumberFormat(undefined, options);
    }
}

/**
 * Builds a formatter from a Power BI format string. Percent formats are shown as
 * percentages, a leading currency symbol is kept, everything else uses grouped numbers.
 */
export function createValueFormatter(formatString: string | undefined, locale: string | undefined, isCount: boolean): ValueFormatter {
    const format = formatString ?? "";
    const isPercent = /%/.test(format.replace(/\\%/g, ""));
    const symbolMatch = /^\\?([$€£¥₹]|kr\.?\s?)/.exec(format.replace(/^"|"$/g, ""));
    const symbol = symbolMatch ? symbolMatch[1] : "";
    const decimalsMatch = /\.(0+)/.exec(format);
    const decimals = decimalsMatch ? Math.min(decimalsMatch[1].length, 6) : isCount ? 0 : 2;

    const compactFmt = safeNumberFormat(locale, {
        notation: "compact",
        maximumFractionDigits: 1,
        style: isPercent ? "percent" : "decimal",
    });
    const fullFmt = safeNumberFormat(locale, {
        maximumFractionDigits: decimals,
        minimumFractionDigits: isCount ? 0 : Math.min(decimals, 2),
        style: isPercent ? "percent" : "decimal",
    });

    const withSymbol = (text: string): string => {
        if (!symbol) {
            return text;
        }
        return text.startsWith("-") ? "-" + symbol + text.slice(1) : symbol + text;
    };

    return {
        compact: (value: number) => withSymbol(compactFmt.format(value)),
        full: (value: number) => withSymbol(fullFmt.format(value)),
    };
}

/** Canvas based text measurement with a small cache, used to truncate long labels. */
export class TextMeasurer {
    private context: CanvasRenderingContext2D | null;
    private cache = new Map<string, number>();

    constructor() {
        const canvas = document.createElement("canvas");
        this.context = canvas.getContext("2d");
    }

    public width(text: string, font: string): number {
        const cacheKey = font + "|" + text;
        const cached = this.cache.get(cacheKey);
        if (cached !== undefined) {
            return cached;
        }
        let width: number;
        if (this.context) {
            this.context.font = font;
            width = this.context.measureText(text).width;
        } else {
            // Rough fallback when canvas is unavailable.
            const size = parseFloat(/(\d+(\.\d+)?)px/.exec(font)?.[1] ?? "12");
            width = text.length * size * 0.55;
        }
        if (this.cache.size > 20000) {
            this.cache.clear();
        }
        this.cache.set(cacheKey, width);
        return width;
    }

    /** Shorten text with an ellipsis so it fits within maxWidth. */
    public truncate(text: string, font: string, maxWidth: number): string {
        if (maxWidth <= 0) {
            return "";
        }
        if (this.width(text, font) <= maxWidth) {
            return text;
        }
        const ellipsis = "…";
        let low = 0;
        let high = text.length;
        while (low < high) {
            const mid = Math.ceil((low + high) / 2);
            if (this.width(text.slice(0, mid) + ellipsis, font) <= maxWidth) {
                low = mid;
            } else {
                high = mid - 1;
            }
        }
        return low === 0 ? ellipsis : text.slice(0, low).trimEnd() + ellipsis;
    }
}
