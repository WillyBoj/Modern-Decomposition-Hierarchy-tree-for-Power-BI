/*
 *  Hierarchy Explorer – tree model.
 *  Pure functions with no DOM or Power BI dependencies so they can be unit tested.
 */

"use strict";

export const UNASSIGNED = "Unassigned";

export interface TreeRow {
    /** One label per hierarchy level, already converted to display text. */
    path: string[];
    /** Measure value for the row, or 1 when counting rows. */
    value: number;
    /** Index of the source row, used to look up its selection identity. */
    rowIndex: number;
    /** Extra tooltip measure values for the row. */
    extras?: number[];
}

export interface TreeNode {
    /** Sequential id, unique within one build. Used in the DOM. */
    id: number;
    /** Stable key built from the label path. Survives data refreshes. */
    key: string;
    name: string;
    depth: number;
    levelName: string;
    value: number;
    rowCount: number;
    /** Sums of the extra tooltip measures. */
    extras: number[];
    /** Source row indices of every row under this node. */
    rows: number[];
    children: TreeNode[];
    parent: TreeNode | null;
    // Layout fields, filled in by layoutTree().
    /** Drawn as a full card. */
    full: boolean;
    /** Not drawn at all (collapsed branch in "hidden" mode). */
    hidden: boolean;
    /** Node box in drawing coordinates. */
    x: number;
    y: number;
    w: number;
    h: number;
    /** Start of the band reserved for the subtree along the sibling axis. */
    top: number;
    /** Size of that band. */
    span: number;
    /** Start and end of the subtree along the level axis. */
    near: number;
    far: number;
}

export interface Tree {
    root: TreeNode;
    nodes: TreeNode[];
    byKey: Map<string, TreeNode>;
    maxDepth: number;
}

const KEY_SEPARATOR = "\u001f";

/** Convert any raw Power BI value to a display label. Blank values become "Unassigned". */
export function toLabel(value: unknown, locale?: string): string {
    if (value === null || value === undefined) {
        return UNASSIGNED;
    }
    if (value instanceof Date) {
        return isNaN(value.getTime()) ? UNASSIGNED : value.toLocaleDateString(locale);
    }
    if (typeof value === "number") {
        return isFinite(value) ? String(value) : UNASSIGNED;
    }
    const text = String(value).trim();
    return text.length === 0 ? UNASSIGNED : text;
}

/** Convert a raw measure value to a finite number (blank → 0). */
export function toNumber(value: unknown): number {
    if (typeof value === "number") {
        return isFinite(value) ? value : 0;
    }
    if (typeof value === "string" && value.trim() !== "") {
        const n = Number(value);
        return isFinite(n) ? n : 0;
    }
    return 0;
}

function addExtras(node: TreeNode, extras: number[] | undefined): void {
    if (!extras) {
        return;
    }
    for (let i = 0; i < extras.length; i++) {
        node.extras[i] = (node.extras[i] ?? 0) + extras[i];
    }
}

function createNode(id: number, key: string, name: string, depth: number, levelName: string, parent: TreeNode | null): TreeNode {
    return {
        id,
        key,
        name,
        depth,
        levelName,
        value: 0,
        rowCount: 0,
        extras: [],
        rows: [],
        children: [],
        parent,
        full: true,
        hidden: false,
        x: 0,
        y: 0,
        w: 0,
        h: 0,
        top: 0,
        span: 0,
        near: 0,
        far: 0,
    };
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Sibling order: descending value, then alphabetical. */
export function compareSiblings(a: TreeNode, b: TreeNode): number {
    if (b.value !== a.value) {
        return b.value - a.value;
    }
    return collator.compare(a.name, b.name);
}

/**
 * Build a tree from flat rows. The root is a synthetic "All" node; level 1 is the first
 * hierarchy field. Duplicate labels under different parents become separate nodes.
 */
export function buildTree(rows: TreeRow[], levelNames: string[], rootName = "All", rootLevelName = "Total"): Tree {
    let nextId = 0;
    const root = createNode(nextId++, "", rootName, 0, rootLevelName, null);
    const byKey = new Map<string, TreeNode>([["", root]]);
    const childIndex = new Map<TreeNode, Map<string, TreeNode>>();
    const depthCount = levelNames.length;

    for (const row of rows) {
        let node = root;
        node.value += row.value;
        node.rowCount += 1;
        node.rows.push(row.rowIndex);
        addExtras(node, row.extras);

        for (let level = 0; level < depthCount; level++) {
            const name = row.path[level] ?? UNASSIGNED;
            let index = childIndex.get(node);
            if (!index) {
                index = new Map<string, TreeNode>();
                childIndex.set(node, index);
            }
            let child = index.get(name);
            if (!child) {
                const key = node.key === "" && node === root ? name : node.key + KEY_SEPARATOR + name;
                child = createNode(nextId++, key, name, level + 1, levelNames[level], node);
                index.set(name, child);
                node.children.push(child);
                byKey.set(key, child);
            }
            child.value += row.value;
            child.rowCount += 1;
            child.rows.push(row.rowIndex);
            addExtras(child, row.extras);
            node = child;
        }
    }

    // Sort siblings and collect nodes in depth-first order.
    const nodes: TreeNode[] = [];
    let maxDepth = 0;
    const stack: TreeNode[] = [root];
    while (stack.length > 0) {
        const node = stack.pop() as TreeNode;
        nodes.push(node);
        maxDepth = Math.max(maxDepth, node.depth);
        node.children.sort(compareSiblings);
        for (let i = node.children.length - 1; i >= 0; i--) {
            stack.push(node.children[i]);
        }
    }

    return { root, nodes, byKey, maxDepth };
}

/** Ancestors from the root down to (but excluding) the node. */
export function ancestorsOf(node: TreeNode): TreeNode[] {
    const result: TreeNode[] = [];
    let current = node.parent;
    while (current) {
        result.unshift(current);
        current = current.parent;
    }
    return result;
}

/** True when `node` is `ancestor` or sits somewhere below it. */
export function isWithin(node: TreeNode, ancestor: TreeNode): boolean {
    let current: TreeNode | null = node;
    while (current) {
        if (current === ancestor) {
            return true;
        }
        current = current.parent;
    }
    return false;
}

/**
 * The node to focus after the focused node is clicked again: its parent,
 * or null (the overview) when the parent is the root.
 */
export function stepBackTarget(focused: TreeNode | null): TreeNode | null {
    if (!focused || !focused.parent || !focused.parent.parent) {
        return null;
    }
    return focused.parent;
}

/**
 * The focus that results from activating `clicked` while `focused` is current.
 * Encodes the essential interaction rule: click to focus, click the focused node again
 * to move back exactly one level, click the root to return to the overview.
 */
export function nextFocus(focused: TreeNode | null, clicked: TreeNode): TreeNode | null {
    if (!clicked.parent) {
        return null;
    }
    if (focused === clicked) {
        return stepBackTarget(focused);
    }
    return clicked;
}

/**
 * Find the node whose underlying rows exactly match a set of row keys.
 * When several nodes share the same rows (single-child chains), the deepest wins.
 */
export function findNodeByRowKeys(tree: Tree, selected: Set<string>, rowKey: (rowIndex: number) => string | undefined): TreeNode | null {
    if (selected.size === 0) {
        return null;
    }
    let best: TreeNode | null = null;
    for (const node of tree.nodes) {
        if (!node.parent || node.rows.length !== selected.size) {
            continue;
        }
        if (best && best.depth >= node.depth) {
            continue;
        }
        let all = true;
        for (const r of node.rows) {
            const key = rowKey(r);
            if (key === undefined || !selected.has(key)) {
                all = false;
                break;
            }
        }
        if (all) {
            best = node;
        }
    }
    return best;
}
