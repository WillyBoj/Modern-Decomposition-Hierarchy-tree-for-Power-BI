/*
 *  Hierarchy Explorer – tree layout, view fitting and camera interpolation.
 *  Pure functions with no DOM dependencies.
 *
 *  The layout works on two axes:
 *  - the level axis (left → right when horizontal, top → bottom when vertical), and
 *  - the sibling axis (top → bottom when horizontal, left → right when vertical).
 *
 *  It is focus-aware. Nodes that matter for the current view are full cards. Every other
 *  node is either compressed into a slim bar (its descendants squeezed into the same band,
 *  like a minimap) or hidden behind its parent, depending on the collapse mode.
 */

"use strict";

import { Tree, TreeNode } from "./tree";

export type Orientation = "horizontal" | "vertical";
export type CollapseMode = "compressed" | "hidden";
export type ConnectorStyle = "curved" | "elbow";

export interface LayoutOptions {
    orientation: Orientation;
    collapse: CollapseMode;
    nodeWidth: number;
    nodeHeight: number;
    /** Gap between levels, along the level axis. */
    levelSpacing: number;
    /** Gap between siblings, along the sibling axis. */
    siblingSpacing: number;
    /** Size of a compressed node across the sibling axis. */
    compactSize: number;
    /** Gap around compressed nodes. */
    compactSpacing: number;
}

export interface Box {
    x: number;
    y: number;
    w: number;
    h: number;
}

/** A node rectangle, used for drawing and animating. */
export type NodePosition = Box;

/** Size and gap for compressed nodes derived from the full card size. */
export function compactMetrics(crossSize: number, siblingSpacing: number): { compactSize: number; compactSpacing: number } {
    return {
        compactSize: Math.max(5, Math.min(10, Math.round(crossSize * 0.16))),
        compactSpacing: Math.max(2, Math.round(siblingSpacing * 0.35)),
    };
}

/**
 * Decide which nodes are drawn as full cards:
 * - every node down to `overviewLevels` deep,
 * - the focused node and all of its descendants,
 * - the focused node's ancestors and their direct children (the context around the path).
 */
export function fullNodePredicate(focused: TreeNode | null, overviewLevels: number): (node: TreeNode) => boolean {
    const path = new Set<TreeNode>();
    let current: TreeNode | null = focused;
    while (current) {
        path.add(current);
        current = current.parent;
    }
    return (node: TreeNode) => {
        if (node.depth <= overviewLevels) {
            return true;
        }
        if (!focused) {
            return false;
        }
        if (node.parent && path.has(node.parent)) {
            return true;
        }
        let ancestor: TreeNode | null = node;
        while (ancestor && ancestor.depth >= focused.depth) {
            if (ancestor === focused) {
                return true;
            }
            ancestor = ancestor.parent;
        }
        return false;
    };
}

/**
 * Lay the tree out. Full nodes reserve a band large enough for themselves and their
 * visible subtree, and stack their children inside it. Compressed nodes keep a slim band
 * and squeeze their descendants into it by weight. Hidden nodes take no space and sit at
 * their parent's centre, so they can grow out of it when they appear.
 * Iterative, so deep or wide trees cannot overflow the call stack.
 */
export function layoutTree(tree: Tree, opts: LayoutOptions, isFull: (node: TreeNode) => boolean): Box {
    const horizontal = opts.orientation === "horizontal";
    const mainSize = horizontal ? opts.nodeWidth : opts.nodeHeight;
    const crossFull = horizontal ? opts.nodeHeight : opts.nodeWidth;
    const levelStep = mainSize + opts.levelSpacing;
    const nodes = tree.nodes; // depth-first pre-order: parents before children

    const cross = new Map<TreeNode, number>(); // node size across the sibling axis
    const start = new Map<TreeNode, number>(); // node start along the sibling axis
    const weight = new Map<TreeNode, number>();

    // Pass 1, parents first: state and own size.
    for (const node of nodes) {
        const parentHidden = node.parent ? node.parent.hidden : false;
        node.full = !parentHidden && isFull(node);
        node.hidden = parentHidden || (!node.full && opts.collapse === "hidden");
        cross.set(node, node.full ? crossFull : node.hidden ? 0 : opts.compactSize);
        node.near = node.depth * levelStep;
    }

    // Pass 2, children first: weight, band size and subtree extent along the level axis.
    for (let i = nodes.length - 1; i >= 0; i--) {
        const node = nodes[i];
        let childWeight = 0;
        let childSpan = 0;
        let far = node.hidden ? -Infinity : node.near + mainSize;
        for (const child of node.children) {
            childWeight += weight.get(child) ?? 0;
            childSpan += child.span;
            far = Math.max(far, child.far);
        }
        weight.set(node, Math.max(1, childWeight));
        const size = cross.get(node) ?? 0;
        if (node.hidden) {
            node.span = 0;
        } else if (node.full) {
            node.span = Math.max(size + opts.siblingSpacing, childSpan);
        } else {
            node.span = size + opts.compactSpacing;
        }
        node.far = far;
    }

    // Pass 3, parents first: place child bands inside each parent band.
    tree.root.top = 0;
    for (const node of nodes) {
        if (node.children.length === 0) {
            continue;
        }
        if (node.full || node.hidden) {
            let childrenSpan = 0;
            for (const child of node.children) {
                childrenSpan += child.span;
            }
            let cursor = node.top + (node.span - childrenSpan) / 2;
            for (const child of node.children) {
                child.top = cursor;
                cursor += child.span;
            }
        } else {
            // Squeeze the descendants of a compressed node into its band, by weight.
            const total = weight.get(node) ?? 1;
            let cursor = node.top;
            for (const child of node.children) {
                const share = node.span * ((weight.get(child) ?? 1) / total);
                child.top = cursor;
                child.span = share;
                cross.set(child, Math.min(opts.compactSize, share * 0.7));
                cursor += share;
            }
        }
    }

    // Pass 4, children first: centre each visible node on its visible children.
    for (let i = nodes.length - 1; i >= 0; i--) {
        const node = nodes[i];
        if (node.hidden) {
            continue;
        }
        const size = cross.get(node) ?? 0;
        let first: TreeNode | null = null;
        let last: TreeNode | null = null;
        for (const child of node.children) {
            if (!child.hidden) {
                first = first ?? child;
                last = child;
            }
        }
        let centre = node.top + node.span / 2;
        if (first && last) {
            const firstStart = start.get(first) ?? 0;
            const lastStart = start.get(last) ?? 0;
            centre = (firstStart + (cross.get(first) ?? 0) / 2 + lastStart + (cross.get(last) ?? 0) / 2) / 2;
        }
        const gap = node.full ? opts.siblingSpacing : opts.compactSpacing;
        const minStart = node.top + Math.min((node.span - size) / 2, gap / 2);
        const maxStart = node.top + node.span - size - (minStart - node.top);
        start.set(node, Math.min(Math.max(centre - size / 2, minStart), Math.max(minStart, maxStart)));
    }

    // Pass 5, parents first: hidden nodes sit at their parent's centre; map to drawing space.
    const compactMain = horizontal ? opts.nodeWidth : opts.nodeHeight * 0.6;
    for (const node of nodes) {
        let s = start.get(node) ?? 0;
        let size = cross.get(node) ?? 0;
        let main = node.full ? mainSize : compactMain;
        if (node.hidden) {
            const parent = node.parent;
            const parentCentre = parent ? (horizontal ? parent.y + parent.h / 2 : parent.x + parent.w / 2) : 0;
            s = parentCentre;
            size = 0;
            main = 0;
            node.near = parent ? (horizontal ? parent.x + parent.w : parent.y + parent.h) : 0;
        }
        if (horizontal) {
            node.x = node.near;
            node.y = s;
            node.w = main;
            node.h = size;
        } else {
            node.x = s;
            node.y = node.near;
            node.w = size;
            node.h = main;
        }
    }

    return subtreeBox(tree.root, opts.orientation);
}

/** Bounds of a node and its visible subtree. */
export function subtreeBox(node: TreeNode, orientation: Orientation): Box {
    const mainLength = Math.max(0, node.far - node.near);
    return orientation === "horizontal"
        ? { x: node.near, y: node.top, w: mainLength, h: node.span }
        : { x: node.top, y: node.near, w: node.span, h: mainLength };
}

/** Bounds of the root plus every visible node down to `levels` deep (node cards only). */
export function overviewBox(tree: Tree, levels: number): Box {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of tree.nodes) {
        if (node.depth > levels || node.hidden) {
            continue;
        }
        minX = Math.min(minX, node.x);
        minY = Math.min(minY, node.y);
        maxX = Math.max(maxX, node.x + node.w);
        maxY = Math.max(maxY, node.y + node.h);
    }
    if (!isFinite(minX)) {
        return { x: 0, y: 0, w: 1, h: 1 };
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export interface FitOptions {
    orientation: Orientation;
    padding: number;
    /** Largest zoom factor, so a single small node is not blown up. */
    maxScale: number;
    /** Smallest zoom factor. Below it, the view anchors instead of fitting. */
    minScale: number;
    /** Align the box to the start of the level axis instead of centring it. */
    alignStart?: boolean;
}

/**
 * Compute a viewBox with the same aspect ratio as the viewport that shows `box`.
 * When the box is too large at `minScale`, the view starts at the beginning of the level
 * axis and is centred on `anchor` along the sibling axis, without scrolling past the box.
 */
export function fitBox(box: Box, viewWidth: number, viewHeight: number, opts: FitOptions, anchor?: number): Box {
    const vw = Math.max(1, viewWidth);
    const vh = Math.max(1, viewHeight);
    const p = opts.padding;
    let scale = Math.min(vw / Math.max(1, box.w + p * 2), vh / Math.max(1, box.h + p * 2), opts.maxScale);
    const clamped = scale < opts.minScale;
    if (clamped) {
        scale = opts.minScale;
    }
    const w = vw / scale;
    const h = vh / scale;
    const horizontal = opts.orientation === "horizontal";
    const alignStart = clamped || !!opts.alignStart;

    // Level axis.
    const mainStart = horizontal ? box.x : box.y;
    const mainLength = horizontal ? box.w : box.h;
    const mainView = horizontal ? w : h;
    const mainCentre = alignStart ? mainStart - p + mainView / 2 : mainStart + mainLength / 2;

    // Sibling axis.
    const crossStart = horizontal ? box.y : box.x;
    const crossLength = horizontal ? box.h : box.w;
    const crossView = horizontal ? h : w;
    let crossCentre = crossStart + crossLength / 2;
    if (clamped && crossView < crossLength + p * 2 && anchor !== undefined) {
        crossCentre = Math.min(Math.max(anchor, crossStart - p + crossView / 2), crossStart + crossLength + p - crossView / 2);
    }

    const cx = horizontal ? mainCentre : crossCentre;
    const cy = horizontal ? crossCentre : mainCentre;
    return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/** Linear interpolation between two boxes. */
export function lerpBox(a: Box, b: Box, t: number): Box {
    return {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        w: a.w + (b.w - a.w) * t,
        h: a.h + (b.h - a.h) * t,
    };
}

export function easeInOutCubic(t: number): number {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export interface ZoomPath {
    /** Box at progress t in [0, 1]. */
    at(t: number): Box;
    /** Relative path length; 0 when the two views are identical. Longer moves get more time. */
    length: number;
}

/**
 * Smooth zoom and pan between two views (van Wijk and Nuij, "Smooth and efficient zooming
 * and panning"). For distant targets the camera pulls out, travels and pushes in, which
 * reads as one continuous zoom instead of a slide. Both boxes should share an aspect ratio.
 */
export function zoomPath(from: Box, to: Box): ZoomPath {
    // Higher rho pulls the camera out further on long moves. sqrt(2) is the paper's
    // default; a little more makes the zoom read clearly as a zoom inside a report.
    const rho = 1.8;
    const rho2 = rho * rho;
    const rho4 = rho2 * rho2;
    const aspect = to.w > 0 ? to.h / to.w : 1;
    const ux0 = from.x + from.w / 2;
    const uy0 = from.y + from.h / 2;
    const w0 = Math.max(1e-6, from.w);
    const ux1 = to.x + to.w / 2;
    const uy1 = to.y + to.h / 2;
    const w1 = Math.max(1e-6, to.w);
    const dx = ux1 - ux0;
    const dy = uy1 - uy0;
    const d2 = dx * dx + dy * dy;
    const toBox = (cx: number, cy: number, w: number): Box => ({ x: cx - w / 2, y: cy - (w * aspect) / 2, w, h: w * aspect });

    if (d2 < 1e-9) {
        const s = Math.log(w1 / w0) / rho;
        return {
            length: Math.abs(s),
            at: (t: number) => (t >= 1 ? { ...to } : toBox(ux0 + t * dx, uy0 + t * dy, w0 * Math.exp(rho * t * s))),
        };
    }
    const d1 = Math.sqrt(d2);
    const b0 = (w1 * w1 - w0 * w0 + rho4 * d2) / (2 * w0 * rho2 * d1);
    const b1 = (w1 * w1 - w0 * w0 - rho4 * d2) / (2 * w1 * rho2 * d1);
    const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0);
    const r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
    const s = (r1 - r0) / rho;
    const coshR0 = Math.cosh(r0);
    if (!isFinite(s)) {
        return { length: 1, at: (t: number) => lerpBox(from, to, t) };
    }
    return {
        length: Math.abs(s),
        at: (t: number) => {
            if (t >= 1) {
                return { ...to };
            }
            const st = t * s;
            const u = (w0 / (rho2 * d1)) * (coshR0 * Math.tanh(rho * st + r0) - Math.sinh(r0));
            return toBox(ux0 + u * dx, uy0 + u * dy, (w0 * coshR0) / Math.cosh(rho * st + r0));
        },
    };
}

/** Connector between a parent and a child box, curved or with rounded elbows. */
export function connectorPath(parent: NodePosition, child: NodePosition, orientation: Orientation, style: ConnectorStyle): string {
    const horizontal = orientation === "horizontal";
    // Start at the parent's outgoing edge, end at the child's incoming edge, in (main, cross).
    const m1 = horizontal ? parent.x + parent.w : parent.y + parent.h;
    const c1 = horizontal ? parent.y + parent.h / 2 : parent.x + parent.w / 2;
    const m2 = horizontal ? child.x : child.y;
    const c2 = horizontal ? child.y + child.h / 2 : child.x + child.w / 2;
    const pt = (m: number, c: number) => (horizontal ? `${round(m)},${round(c)}` : `${round(c)},${round(m)}`);
    const mm = m1 + (m2 - m1) / 2;

    if (style === "curved") {
        return `M${pt(m1, c1)} C${pt(mm, c1)} ${pt(mm, c2)} ${pt(m2, c2)}`;
    }
    const dc = c2 - c1;
    const r = Math.min(8, Math.abs(dc) / 2, Math.abs(m2 - m1) / 2);
    if (r < 0.5) {
        return `M${pt(m1, c1)} L${pt(m2, c2)}`;
    }
    const sc = Math.sign(dc);
    const sm = Math.sign(m2 - m1) || 1;
    return [
        `M${pt(m1, c1)}`,
        `L${pt(mm - sm * r, c1)}`,
        `Q${pt(mm, c1)} ${pt(mm, c1 + sc * r)}`,
        `L${pt(mm, c2 - sc * r)}`,
        `Q${pt(mm, c2)} ${pt(mm + sm * r, c2)}`,
        `L${pt(m2, c2)}`,
    ].join(" ");
}

function round(n: number): number {
    return Math.round(n * 10) / 10;
}
