/*
 *  Hierarchy Explorer – Power BI custom visual
 *
 *  An interactive hierarchy, drawn left to right or as a top-down org chart. Click a node
 *  to enter it: the camera zooms in and the branch opens. Click it again to step back
 *  exactly one level. Built with native DOM and SVG; the only runtime libraries are
 *  Microsoft's Power BI API typings and formatting model utilities.
 */

"use strict";

import "./../style/visual.less";

import powerbi from "powerbi-visuals-api";
import { FormattingSettingsService } from "powerbi-visuals-utils-formattingmodel";

import { VisualFormattingSettingsModel, clampSetting, enumValue } from "./settings";
import { Tree, TreeNode, TreeRow, buildTree, toLabel, toNumber, ancestorsOf, isWithin, nextFocus, stepBackTarget, findNodeByRowKeys } from "./tree";
import {
    Box,
    NodePosition,
    Orientation,
    CollapseMode,
    ConnectorStyle,
    layoutTree,
    subtreeBox,
    overviewBox,
    fitBox,
    lerpBox,
    easeInOutCubic,
    zoomPath,
    connectorPath,
    compactMetrics,
    fullNodePredicate,
} from "./layout";
import { createValueFormatter, TextMeasurer, ValueFormatter } from "./format";
import { DetailColumn, DetailEntry, collectDetails, summarizeDetail, initialsOf, isWebLink } from "./details";

import IVisual = powerbi.extensibility.visual.IVisual;
import IVisualHost = powerbi.extensibility.visual.IVisualHost;
import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
import ISelectionManager = powerbi.extensibility.ISelectionManager;
import ISelectionId = powerbi.visuals.ISelectionId;
import ITooltipService = powerbi.extensibility.ITooltipService;
import IVisualEventService = powerbi.extensibility.IVisualEventService;
import VisualTooltipDataItem = powerbi.extensibility.VisualTooltipDataItem;
import DataView = powerbi.DataView;
import DataViewTable = powerbi.DataViewTable;

const SVG_NS = "http://www.w3.org/2000/svg";
const FONT_FAMILY = "\"Segoe UI\", wf_segoe-ui_normal, \"Helvetica Neue\", Helvetica, Arial, sans-serif";
const ROOT_NAME = "All";
const ROOT_LEVEL_NAME = "Total";
const PAN_THRESHOLD = 4;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 4;
/** Above this many changing nodes, nodes snap into place (the camera still animates). */
const MAX_ANIMATED_NODES = 2500;
/** Tooltips pass node identities for report page tooltips up to this many rows. */
const MAX_TOOLTIP_IDENTITIES = 2000;

interface Theme {
    highContrast: boolean;
    text: string;
    muted: string;
    title: string;
    nodeFill: string;
    hairline: string;
    track: string;
    selected: string;
    connector: string;
    connectorStrong: string;
    background: string;
    levelColors: [string, string, string, string];
}

interface ResolvedSettings {
    showTitle: boolean;
    titleText: string;
    subtitleText: string;
    fontSize: number;
    nodeWidth: number;
    nodeHeight: number;
    cornerRadius: number;
    showValues: boolean;
    showLevelNames: boolean;
    showShareBar: boolean;
    showInitials: boolean;
    showDetails: boolean;
    panelWidth: number;
    showAvatar: boolean;
    showChildren: boolean;
    detailsInTooltip: boolean;
    orientation: Orientation;
    collapse: CollapseMode;
    connectorStyle: ConnectorStyle;
    levelSpacing: number;
    siblingSpacing: number;
    overviewLevels: number;
    animationDuration: number;
    showLevelHeaders: boolean;
    showBreadcrumb: boolean;
    showZoomControls: boolean;
    crossFilter: boolean;
    dimOpacity: number;
    canvasNavigation: boolean;
    respectReducedMotion: boolean;
}

interface NodeRefs {
    g: SVGGElement;
    body: SVGGElement;
    shadow: SVGRectElement;
    card: SVGRectElement;
    ring: SVGRectElement;
    /** Labels, share bar and badge are created the first time a node is drawn as a full card. */
    badge: SVGGElement | null;
    decorated: boolean;
    /** Last applied shape and style, to skip DOM writes that would change nothing. */
    shapeKey: string;
    styleKey: string;
}

interface CardMetrics {
    nameFont: string;
    subFont: string;
    valueFont: string;
    padX: number;
    nameBaseline: number;
    subBaseline: number;
    twoLines: boolean;
    barY: number;
}

interface Motion {
    node: TreeNode;
    from: Box;
    to: Box;
    fade: "in" | "out" | null;
}

interface PanState {
    pointerId: number;
    startX: number;
    startY: number;
    startBox: Box;
    moved: boolean;
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, cls?: string): SVGElementTagNameMap[K] {
    const el = document.createElementNS(SVG_NS, tag);
    if (cls) {
        el.setAttribute("class", cls);
    }
    return el;
}

function htmlEl<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    if (cls) {
        el.className = cls;
    }
    if (text !== undefined) {
        el.textContent = text;
    }
    return el;
}

/** Small line icon for toolbar buttons, built with DOM APIs. */
function icon(paths: string[]): SVGSVGElement {
    const svg = svgEl("svg", "he-icon");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    for (const d of paths) {
        const p = svgEl("path");
        p.setAttribute("d", d);
        svg.appendChild(p);
    }
    return svg;
}

export class Visual implements IVisual {
    private readonly host: IVisualHost;
    private readonly element: HTMLElement;
    private readonly selectionManager: ISelectionManager;
    private readonly tooltipService: ITooltipService;
    private readonly events: IVisualEventService;
    private readonly formattingSettingsService: FormattingSettingsService;
    private readonly measurer = new TextMeasurer();
    private formattingSettings: VisualFormattingSettingsModel = new VisualFormattingSettingsModel();

    // DOM
    private readonly rootEl: HTMLDivElement;
    private readonly headerEl: HTMLDivElement;
    private readonly titleEl: HTMLDivElement;
    private readonly subtitleEl: HTMLDivElement;
    private readonly toolbarEl: HTMLDivElement;
    private readonly breadcrumbEl: HTMLElement;
    private readonly breadcrumbList: HTMLOListElement;
    private readonly overviewButton: HTMLButtonElement;
    private readonly stageEl: HTMLDivElement;
    private readonly levelHeadersEl: HTMLDivElement;
    private readonly canvasEl: HTMLDivElement;
    private readonly svg: SVGSVGElement;
    private readonly linksGroup: SVGGElement;
    private readonly nodesGroup: SVGGElement;
    private readonly zoomEl: HTMLDivElement;
    private readonly messageEl: HTMLDivElement;
    private readonly panelEl: HTMLElement;

    // Data
    private tree: Tree | null = null;
    private nodeById = new Map<number, TreeNode>();
    private table: DataViewTable | null = null;
    private rowIds: Array<ISelectionId | undefined> = [];
    private formatter: ValueFormatter = createValueFormatter(undefined, undefined, true);
    private shareFormatter = createValueFormatter("0%", undefined, false);
    private valueLabel = "Rows";
    private extraColumns: Array<{ name: string; formatter: ValueFormatter }> = [];
    private hasMeasure = false;
    private levelNames: string[] = [];
    private detailColumns: DetailColumn[] = [];
    private detailCache = new Map<number, DetailEntry[]>();
    /** The focused node whose details panel the user closed; it reopens on the next node. */
    private panelDismissedKey: string | null = null;
    private panelMode: "right" | "bottom" | "none" = "none";

    // Change detection: host updates that change nothing must not interrupt an animation.
    private dataSignature = "";
    private settingsSignature = "";
    private viewportSignature = "";

    // Drawing
    private settings: ResolvedSettings | null = null;
    private theme: Theme | null = null;
    private card: CardMetrics | null = null;
    private nodeRefs = new Map<number, NodeRefs>();
    private linkEls = new Map<number, SVGPathElement>();
    private linkKeys = new Map<number, string>();
    private headerEls: HTMLDivElement[] = [];
    /** What is on screen right now, so a new animation can start from mid-flight positions. */
    private drawn = new Map<number, Box>();
    private shown = new Set<number>();

    // Interaction
    private focusKey: string | null = null;
    private cursorId = 0;
    private rovingId = -1;
    private viewBox: Box = { x: 0, y: 0, w: 1, h: 1 };
    private animationFrame = 0;
    private finishAnimation: (() => void) | null = null;
    private interruptAnimation: (() => void) | null = null;
    private pan: PanState | null = null;
    private suppressClick = false;
    private allowInteractions = true;
    private lastCrossFilter = true;
    private canvasSize = { width: 1, height: 1 };
    private canvasOffset = { left: 0, top: 0 };
    private elementOffset = { left: 0, top: 0 };

    constructor(options?: VisualConstructorOptions) {
        if (!options) {
            throw new Error("Hierarchy Explorer requires visual constructor options.");
        }
        this.host = options.host;
        this.element = options.element;
        this.selectionManager = this.host.createSelectionManager();
        this.tooltipService = this.host.tooltipService;
        this.events = this.host.eventService;
        this.formattingSettingsService = new FormattingSettingsService();

        this.rootEl = htmlEl("div", "he-root");
        this.headerEl = htmlEl("div", "he-header");
        this.titleEl = htmlEl("div", "he-title");
        this.titleEl.setAttribute("role", "heading");
        this.titleEl.setAttribute("aria-level", "2");
        this.subtitleEl = htmlEl("div", "he-subtitle");
        this.headerEl.append(this.titleEl, this.subtitleEl);

        this.toolbarEl = htmlEl("div", "he-toolbar");
        this.breadcrumbEl = htmlEl("nav", "he-breadcrumb");
        this.breadcrumbEl.setAttribute("aria-label", "Hierarchy path");
        this.breadcrumbList = htmlEl("ol", "he-breadcrumb-list");
        this.breadcrumbEl.appendChild(this.breadcrumbList);
        this.overviewButton = htmlEl("button", "he-overview");
        this.overviewButton.type = "button";
        this.overviewButton.title = "Show the whole hierarchy";
        this.overviewButton.append(icon(["M2.5 6V2.5H6", "M10 2.5h3.5V6", "M13.5 10v3.5H10", "M6 13.5H2.5V10"]), htmlEl("span", undefined, "Overview"));
        this.toolbarEl.append(this.breadcrumbEl, this.overviewButton);

        this.stageEl = htmlEl("div", "he-stage");
        this.levelHeadersEl = htmlEl("div", "he-level-headers");
        this.levelHeadersEl.setAttribute("aria-hidden", "true");
        this.svg = svgEl("svg", "he-svg");
        this.svg.setAttribute("role", "tree");
        this.svg.setAttribute("aria-label", "Hierarchy tree");
        this.svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
        this.linksGroup = svgEl("g", "he-links");
        this.nodesGroup = svgEl("g", "he-nodes");
        this.svg.append(this.linksGroup, this.nodesGroup);

        this.zoomEl = htmlEl("div", "he-zoom");
        const zoomIn = this.zoomButton("Zoom in", ["M8 3.5v9", "M3.5 8h9"]);
        const zoomOut = this.zoomButton("Zoom out", ["M3.5 8h9"]);
        const zoomFit = this.zoomButton("Fit to view", ["M2.5 6V2.5H6", "M10 2.5h3.5V6", "M13.5 10v3.5H10", "M6 13.5H2.5V10"]);
        zoomIn.addEventListener("click", () => this.zoomBy(1.35));
        zoomOut.addEventListener("click", () => this.zoomBy(1 / 1.35));
        zoomFit.addEventListener("click", () => this.tree && this.animateTo(this.targetBox(), true));
        this.zoomEl.append(zoomIn, zoomOut, zoomFit);

        this.panelEl = htmlEl("aside", "he-panel");
        this.panelEl.setAttribute("aria-label", "Details");
        this.panelEl.setAttribute("aria-hidden", "true");
        this.panelEl.addEventListener("click", (event) => this.onPanelClick(event));
        // Wheel and drags inside the panel scroll the panel, not the tree.
        this.panelEl.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });

        this.canvasEl = htmlEl("div", "he-canvas");
        this.canvasEl.append(this.svg, this.zoomEl, this.panelEl);
        this.messageEl = htmlEl("div", "he-message");
        this.messageEl.setAttribute("role", "status");
        this.stageEl.append(this.levelHeadersEl, this.canvasEl, this.messageEl);

        this.rootEl.append(this.headerEl, this.toolbarEl, this.stageEl);
        this.element.appendChild(this.rootEl);

        this.bindEvents();
    }

    private zoomButton(label: string, paths: string[]): HTMLButtonElement {
        const button = htmlEl("button", "he-zoom-button");
        button.type = "button";
        button.title = label;
        button.setAttribute("aria-label", label);
        button.appendChild(icon(paths));
        return button;
    }

    // ------------------------------------------------------------------ update

    public update(options: VisualUpdateOptions): void {
        this.events.renderingStarted(options);
        try {
            this.render(options);
            this.events.renderingFinished(options);
        } catch (error) {
            this.showMessage("This visual could not be drawn. Remove the fields and add them again.");
            this.events.renderingFailed(options, error instanceof Error ? error.message : String(error));
        }
    }

    private render(options: VisualUpdateOptions): void {
        const dataView = options.dataViews?.[0];
        const palette = this.host.colorPalette as powerbi.extensibility.ISandboxExtendedColorPalette;
        const settingsSignature = JSON.stringify(dataView?.metadata?.objects ?? {}) + "|" + (palette?.isHighContrast ? "hc" : "") + "|" + this.host.hostCapabilities?.allowInteractions;
        const viewportSignature = `${Math.round(options.viewport?.width ?? 0)}x${Math.round(options.viewport?.height ?? 0)}`;

        const table = dataView?.table;
        const hierarchyColumns = (table?.columns ?? [])
            .map((column, index) => ({ column, index }))
            .filter((c) => c.column.roles?.["hierarchy"]);
        const dataSignature = table && hierarchyColumns.length > 0 ? signatureOf(table) : "";

        const dataChanged = dataSignature !== this.dataSignature;
        const settingsChanged = settingsSignature !== this.settingsSignature;
        const viewportChanged = viewportSignature !== this.viewportSignature;
        if (!dataChanged && !settingsChanged && !viewportChanged && this.tree) {
            // Typically the host echoing our own selection. Leave the running animation alone.
            return;
        }
        this.viewportSignature = viewportSignature;

        if (settingsChanged || !this.settings) {
            this.settingsSignature = settingsSignature;
            this.formattingSettings = this.formattingSettingsService.populateFormattingSettingsModel(VisualFormattingSettingsModel, dataView as DataView);
            this.settings = this.resolveSettings();
            this.theme = this.resolveTheme();
            this.allowInteractions = this.host.hostCapabilities?.allowInteractions !== false;
            this.applyChrome();
        }

        if (!dataView || !table || hierarchyColumns.length === 0) {
            this.dataSignature = "";
            this.clearTree();
            this.updateTitle();
            this.showMessage("Add one or more fields to Hierarchy to build the tree, and a measure to Value to size each node.");
            return;
        }

        if (dataChanged) {
            this.dataSignature = dataSignature;
            this.buildFromTable(dataView, table, hierarchyColumns);
        }
        this.updateTitle();

        if (!this.tree || this.tree.root.rowCount === 0) {
            this.clearTree();
            this.showMessage("No rows match the current filters.");
            return;
        }

        this.hideMessage();
        this.measureCanvas();
        this.cancelAnimation();
        if (dataChanged || settingsChanged || this.nodeRefs.size === 0) {
            this.restoreFocus();
            this.layout();
            this.renderTree();
            this.applyFocusStyles();
            this.updateBreadcrumb();
            this.updateRovingTabIndex();
        }
        this.renderPanel();
        this.applyViewBox(this.targetBox());
    }

    private buildFromTable(dataView: DataView, table: DataViewTable, hierarchyColumns: Array<{ column: powerbi.DataViewMetadataColumn; index: number }>): void {
        const ordered = hierarchyColumns.slice(0, 8).sort((a, b) => {
            const ai = rolePosition(a.column, "hierarchy") ?? a.index;
            const bi = rolePosition(b.column, "hierarchy") ?? b.index;
            return ai - bi;
        });
        const valueIndex = table.columns.findIndex((c) => c.roles?.["value"]);
        const valueColumn = valueIndex >= 0 ? table.columns[valueIndex] : undefined;
        const locale = this.host.locale;
        const extraIndexes = table.columns
            .map((column, index) => ({ column, index }))
            .filter((c) => c.column.roles?.["tooltips"] && !c.column.roles?.["value"] && !c.column.roles?.["hierarchy"]);

        const rows: TreeRow[] = [];
        const sourceRows = table.rows ?? [];
        for (let r = 0; r < sourceRows.length; r++) {
            const row = sourceRows[r];
            rows.push({
                path: ordered.map((c) => toLabel(row[c.index], locale)),
                value: valueColumn ? toNumber(row[valueIndex]) : 1,
                rowIndex: r,
                extras: extraIndexes.length > 0 ? extraIndexes.map((c) => toNumber(row[c.index])) : undefined,
            });
        }

        this.levelNames = ordered.map((c) => c.column.displayName || "Level");
        this.table = table;
        this.rowIds = new Array(sourceRows.length);
        this.hasMeasure = !!valueColumn;
        this.valueLabel = valueColumn?.displayName ?? "Rows";
        this.formatter = createValueFormatter(valueColumn?.format, locale, !valueColumn);
        this.shareFormatter = createValueFormatter("0.0%", locale, false);
        this.extraColumns = extraIndexes.map((c) => ({
            name: c.column.displayName,
            formatter: createValueFormatter(c.column.format, locale, false),
        }));
        this.detailColumns = table.columns
            .map((column, index) => ({ column, index }))
            .filter((c) => c.column.roles?.["details"] && !c.column.roles?.["hierarchy"])
            .map((c) => ({ name: c.column.displayName, index: c.index, format: detailFormatter(c.column, locale) }));
        this.detailCache.clear();
        this.tree = buildTree(rows, this.levelNames, ROOT_NAME, ROOT_LEVEL_NAME);
        this.nodeById = new Map(this.tree.nodes.map((n) => [n.id, n]));

        if (dataView.metadata?.segment) {
            this.host.displayWarningIcon(
                "Not all data is shown",
                "Hierarchy Explorer shows up to 30,000 rows. Filter the report or use fewer hierarchy levels to see everything.",
            );
        }
    }

    private resolveSettings(): ResolvedSettings {
        const f = this.formattingSettings;
        const orientation = enumValue<Orientation>(f.layout.orientation, ["horizontal", "vertical"], "horizontal");
        const collapseSetting = enumValue(f.layout.collapsedBranches, ["auto", "compressed", "hidden"] as const, "auto");
        const connectorSetting = enumValue(f.layout.connectorStyle, ["auto", "curved", "elbow"] as const, "auto");
        return {
            showTitle: f.title.show.value,
            titleText: (f.title.text.value ?? "").trim(),
            subtitleText: (f.title.subtitle.value ?? "").trim(),
            fontSize: clampSetting("fontSize", f.nodes.fontSize.value, 10),
            nodeWidth: clampSetting("nodeWidth", f.nodes.nodeWidth.value, 184),
            nodeHeight: clampSetting("nodeHeight", f.nodes.nodeHeight.value, 58),
            cornerRadius: clampSetting("cornerRadius", f.nodes.cornerRadius.value, 10),
            showValues: f.nodes.showValues.value,
            showLevelNames: f.nodes.showLevelNames.value,
            showShareBar: f.nodes.showShareBar.value,
            showInitials: f.nodes.showInitials.value,
            showDetails: f.details.show.value,
            panelWidth: clampSetting("panelWidth", f.details.panelWidth.value, 330),
            showAvatar: f.details.showAvatar.value,
            showChildren: f.details.showChildren.value,
            detailsInTooltip: f.details.showInTooltip.value,
            orientation,
            collapse: collapseSetting === "auto" ? (orientation === "vertical" ? "hidden" : "compressed") : collapseSetting,
            connectorStyle: connectorSetting === "auto" ? (orientation === "vertical" ? "elbow" : "curved") : connectorSetting,
            levelSpacing: clampSetting("levelSpacing", f.layout.levelSpacing.value, 56),
            siblingSpacing: clampSetting("siblingSpacing", f.layout.siblingSpacing.value, 12),
            overviewLevels: Math.round(clampSetting("overviewLevels", f.layout.overviewLevels.value, 1)),
            animationDuration: clampSetting("animationDuration", f.layout.animationDuration.value, 650),
            showLevelHeaders: f.layout.showLevelHeaders.value,
            showBreadcrumb: f.layout.showBreadcrumb.value,
            showZoomControls: f.layout.showZoomControls.value,
            crossFilter: f.interaction.crossFilter.value,
            dimOpacity: clampSetting("dimOpacity", f.interaction.dimOpacity.value, 30) / 100,
            canvasNavigation: f.interaction.canvasNavigation.value,
            respectReducedMotion: f.interaction.respectReducedMotion.value,
        };
    }

    private resolveTheme(): Theme {
        const f = this.formattingSettings;
        const palette = this.host.colorPalette as powerbi.extensibility.ISandboxExtendedColorPalette;
        if (palette?.isHighContrast) {
            const fg = palette.foreground.value;
            const bg = palette.background.value;
            const sel = palette.foregroundSelected?.value ?? fg;
            return {
                highContrast: true,
                text: fg,
                muted: fg,
                title: fg,
                nodeFill: bg,
                hairline: fg,
                track: bg,
                selected: sel,
                connector: fg,
                connectorStrong: fg,
                background: bg,
                levelColors: [fg, fg, fg, fg],
            };
        }
        const connector = f.colors.connectorColor.value.value;
        return {
            highContrast: false,
            text: f.nodes.fontColor.value.value,
            muted: "#6B7385",
            title: f.title.fontColor.value.value,
            nodeFill: "#FFFFFF",
            hairline: "#E1E5EC",
            track: "#EDF0F4",
            selected: f.colors.selectedColor.value.value,
            connector,
            connectorStrong: shade(connector, -0.32),
            background: f.colors.backgroundColor.value.value,
            levelColors: [
                f.colors.rootColor.value.value,
                f.colors.level1Color.value.value,
                f.colors.level2Color.value.value,
                f.colors.deeperColor.value.value,
            ],
        };
    }

    public getFormattingModel(): powerbi.visuals.FormattingModel {
        return this.formattingSettingsService.buildFormattingModel(this.formattingSettings);
    }

    public destroy(): void {
        this.cancelAnimation();
        this.hideTooltip();
    }

    // ------------------------------------------------------------------ chrome

    private applyChrome(): void {
        const s = this.settings as ResolvedSettings;
        const t = this.theme as Theme;
        const style = this.rootEl.style;
        style.setProperty("--he-bg", t.background);
        style.setProperty("--he-text", t.text);
        style.setProperty("--he-muted", t.muted);
        style.setProperty("--he-title", t.title);
        style.setProperty("--he-card", t.nodeFill);
        style.setProperty("--he-hairline", t.hairline);
        style.setProperty("--he-selected", t.selected);
        style.setProperty("--he-connector", t.connector);
        style.setProperty("--he-connector-strong", t.connectorStrong);
        style.setProperty("--he-dim-opacity", String(s.dimOpacity));
        style.setProperty("--he-font", FONT_FAMILY);
        this.rootEl.classList.toggle("he-high-contrast", t.highContrast);
        this.rootEl.classList.toggle("he-vertical", s.orientation === "vertical");
        this.headerEl.style.display = s.showTitle ? "" : "none";
        this.breadcrumbEl.style.visibility = s.showBreadcrumb ? "visible" : "hidden";
        this.levelHeadersEl.style.display = s.showLevelHeaders ? "" : "none";
        this.zoomEl.style.display = s.showZoomControls ? "" : "none";

        // Level headers run along the top when horizontal and down the left when vertical.
        if (s.orientation === "vertical" && this.levelHeadersEl.parentElement !== this.canvasEl) {
            this.canvasEl.insertBefore(this.levelHeadersEl, this.zoomEl);
        } else if (s.orientation === "horizontal" && this.levelHeadersEl.parentElement !== this.stageEl) {
            this.stageEl.insertBefore(this.levelHeadersEl, this.canvasEl);
        }

        if (!s.crossFilter && this.lastCrossFilter && this.selectionManager.hasSelection()) {
            this.selectionManager.clear();
        }
        this.lastCrossFilter = s.crossFilter;
    }

    private updateTitle(): void {
        const s = this.settings as ResolvedSettings;
        const fallback = this.levelNames.length > 0 && this.tree ? this.levelNames.join(" → ") : "Hierarchy Explorer";
        this.titleEl.textContent = s.titleText || fallback;
        this.subtitleEl.textContent = s.subtitleText;
        this.subtitleEl.style.display = s.subtitleText ? "" : "none";
    }

    private showMessage(text: string): void {
        this.messageEl.textContent = text;
        this.messageEl.style.display = "flex";
        this.canvasEl.style.visibility = "hidden";
        this.levelHeadersEl.style.visibility = "hidden";
        this.toolbarEl.style.visibility = "hidden";
    }

    private hideMessage(): void {
        this.messageEl.textContent = "";
        this.messageEl.style.display = "none";
        this.canvasEl.style.visibility = "visible";
        this.levelHeadersEl.style.visibility = "visible";
        this.toolbarEl.style.visibility = "visible";
    }

    private clearTree(): void {
        this.cancelAnimation();
        this.hideTooltip();
        this.tree = null;
        this.focusKey = null;
        this.levelNames = [];
        this.nodeById.clear();
        this.nodeRefs.clear();
        this.linkEls.clear();
        this.linkKeys.clear();
        this.drawn.clear();
        this.shown.clear();
        this.linksGroup.replaceChildren();
        this.nodesGroup.replaceChildren();
        this.levelHeadersEl.replaceChildren();
        this.headerEls = [];
        this.breadcrumbList.replaceChildren();
        this.detailCache.clear();
        this.panelMode = "none";
        this.panelEl.replaceChildren();
        this.panelEl.setAttribute("aria-hidden", "true");
        this.rootEl.classList.remove("he-panel-open", "he-panel-right", "he-panel-bottom");
    }

    // ------------------------------------------------------------------ layout and drawing

    private levelColor(depth: number): string {
        const colors = (this.theme as Theme).levelColors;
        return colors[Math.min(depth, 3)];
    }

    /** Lay the tree out for the current focus. */
    private layout(): void {
        const s = this.settings as ResolvedSettings;
        const crossSize = s.orientation === "horizontal" ? s.nodeHeight : s.nodeWidth;
        const compact = compactMetrics(crossSize, s.siblingSpacing);
        layoutTree(
            this.tree as Tree,
            {
                orientation: s.orientation,
                collapse: s.collapse,
                nodeWidth: s.nodeWidth,
                nodeHeight: s.nodeHeight,
                levelSpacing: s.levelSpacing,
                siblingSpacing: s.siblingSpacing,
                compactSize: compact.compactSize,
                compactSpacing: compact.compactSpacing,
            },
            fullNodePredicate(this.focusedNode(), s.overviewLevels),
        );
    }

    private renderTree(): void {
        const tree = this.tree as Tree;
        const s = this.settings as ResolvedSettings;

        const h = s.nodeHeight;
        const namePx = Math.round(s.fontSize * (4 / 3) * 10) / 10;
        const subPx = Math.max(9, Math.round(namePx * 0.84 * 10) / 10);
        const twoLines = s.showLevelNames || s.showValues;
        const barReserve = s.showShareBar ? 9 : 0;
        const lineGap = Math.max(2, Math.round(namePx * 0.3));
        const blockHeight = twoLines ? namePx + lineGap + subPx : namePx;
        const contentHeight = h - barReserve;
        const nameBaseline = contentHeight / 2 - blockHeight / 2 + namePx * 0.82 + (barReserve > 0 ? 2 : 0);
        this.card = {
            nameFont: `600 ${namePx}px ${FONT_FAMILY}`,
            subFont: `400 ${subPx}px ${FONT_FAMILY}`,
            valueFont: `600 ${subPx}px ${FONT_FAMILY}`,
            padX: 14,
            nameBaseline,
            subBaseline: nameBaseline + lineGap + subPx,
            twoLines,
            barY: h - 10,
        };

        const linkFragment = document.createDocumentFragment();
        const nodeFragment = document.createDocumentFragment();
        this.nodeRefs.clear();
        this.linkEls.clear();
        this.linkKeys.clear();
        this.drawn.clear();
        this.shown.clear();
        this.rovingId = -1;

        for (const node of tree.nodes) {
            if (node.parent) {
                const path = svgEl("path", "he-link");
                linkFragment.appendChild(path);
                this.linkEls.set(node.id, path);
            }

            const g = svgEl("g", "he-node");
            g.setAttribute("data-id", String(node.id));
            g.setAttribute("role", "treeitem");
            g.setAttribute("aria-level", String(node.depth + 1));
            g.setAttribute("aria-label", this.ariaLabel(node));
            g.setAttribute("tabindex", "-1");
            const body = svgEl("g", "he-body");
            const shadow = svgEl("rect", "he-shadow");
            const card = svgEl("rect", "he-card");
            const ring = svgEl("rect", "he-ring");
            body.append(shadow, card, ring);
            g.appendChild(body);
            nodeFragment.appendChild(g);

            const refs: NodeRefs = { g, body, shadow, card, ring, badge: null, decorated: false, shapeKey: "", styleKey: "" };
            this.nodeRefs.set(node.id, refs);
            this.applyNodeShape(node, refs);
            this.setShown(node, !node.hidden);
            this.placeNode(node, node);
        }
        for (const node of tree.nodes) {
            if (node.parent) {
                this.placeLink(node, node.parent, node);
            }
        }

        this.linksGroup.replaceChildren(linkFragment);
        this.nodesGroup.replaceChildren(nodeFragment);
        this.buildLevelHeaders();
    }

    /** Add the parts only a full card needs: labels, share bar and the child count badge. */
    private decorate(node: TreeNode, refs: NodeRefs): void {
        const s = this.settings as ResolvedSettings;
        const c = this.card as CardMetrics;
        const w = s.nodeWidth;
        const right = w - c.padX;
        let left = c.padX;

        if (s.showInitials && node.parent) {
            // A small initials avatar, centred on the text block, for people-style charts.
            const r = Math.max(9, Math.min(16, (c.subBaseline - c.nameBaseline + 22) / 2));
            const cy = c.twoLines ? (c.nameBaseline - 10 + c.subBaseline + 2) / 2 : c.nameBaseline - 5;
            const avatar = svgEl("circle", "he-initials-bg");
            avatar.setAttribute("cx", String(round1(c.padX + r)));
            avatar.setAttribute("cy", String(round1(cy)));
            avatar.setAttribute("r", String(round1(r)));
            avatar.setAttribute("fill", this.levelColor(node.depth));
            const initials = svgEl("text", "he-initials");
            initials.setAttribute("x", String(round1(c.padX + r)));
            initials.setAttribute("y", String(round1(cy + r * 0.36)));
            initials.setAttribute("text-anchor", "middle");
            initials.style.font = `600 ${round1(r * 0.82)}px ${FONT_FAMILY}`;
            initials.textContent = initialsOf(node.name);
            refs.body.append(avatar, initials);
            left = c.padX + r * 2 + 9;
        }

        const name = svgEl("text", "he-name");
        name.setAttribute("x", String(left));
        name.setAttribute("y", String(round1(c.nameBaseline)));
        name.style.font = c.nameFont;
        name.textContent = this.measurer.truncate(node.name, c.nameFont, right - left);
        refs.body.appendChild(name);

        if (c.twoLines) {
            let valueWidth = 0;
            if (s.showValues) {
                const valueText = this.formatter.compact(node.value);
                const value = svgEl("text", "he-value");
                value.setAttribute("x", String(right));
                value.setAttribute("y", String(round1(c.subBaseline)));
                value.setAttribute("text-anchor", "end");
                value.style.font = c.valueFont;
                value.textContent = valueText;
                valueWidth = this.measurer.width(valueText, c.valueFont) + 10;
                refs.body.appendChild(value);
            }
            if (s.showLevelNames) {
                const dotR = 3;
                const dot = svgEl("circle", "he-level-dot");
                dot.setAttribute("cx", String(left + dotR));
                dot.setAttribute("cy", String(round1(c.subBaseline - dotR - 1)));
                dot.setAttribute("r", String(dotR));
                dot.setAttribute("fill", this.levelColor(node.depth));
                const level = svgEl("text", "he-level");
                level.setAttribute("x", String(left + dotR * 2 + 5));
                level.setAttribute("y", String(round1(c.subBaseline)));
                level.style.font = c.subFont;
                level.textContent = this.measurer.truncate(node.levelName, c.subFont, right - left - dotR * 2 - 5 - valueWidth);
                refs.body.append(dot, level);
            }
        }

        if (s.showShareBar && node.parent) {
            const share = shareOf(node);
            const trackWidth = w - c.padX * 2;
            const track = svgEl("rect", "he-track");
            setRect(track, c.padX, c.barY, trackWidth, 3, 1.5);
            refs.body.appendChild(track);
            if (share > 0) {
                const bar = svgEl("rect", "he-bar");
                setRect(bar, c.padX, c.barY, Math.max(3, trackWidth * share), 3, 1.5);
                bar.setAttribute("fill", this.levelColor(node.depth));
                refs.body.appendChild(bar);
            }
        }

        if (node.children.length > 0) {
            const badge = svgEl("g", "he-badge");
            const dot = svgEl("circle", "he-badge-dot");
            dot.setAttribute("r", "3.5");
            const count = String(node.children.length);
            const pillWidth = 12 + count.length * 6;
            const pill = svgEl("rect", "he-badge-pill");
            setRect(pill, -pillWidth / 2, -8, pillWidth, 16, 8);
            const label = svgEl("text", "he-badge-text");
            label.setAttribute("text-anchor", "middle");
            label.setAttribute("y", "3.5");
            label.textContent = count;
            badge.append(dot, pill, label);
            refs.body.appendChild(badge);
            refs.badge = badge;
        }
        refs.decorated = true;
    }

    /** Switch a node between a full card and a compressed bar. */
    private applyNodeShape(node: TreeNode, refs: NodeRefs): void {
        const s = this.settings as ResolvedSettings;
        const t = this.theme as Theme;
        const expanded = node.children.some((child) => child.full);
        const key = `${node.full ? 1 : 0}|${round1(node.w)}|${round1(node.h)}|${expanded ? 1 : 0}`;
        if (refs.shapeKey === key || node.hidden) {
            return;
        }
        refs.shapeKey = key;
        refs.styleKey = "";
        if (node.full && !refs.decorated) {
            this.decorate(node, refs);
        }
        const w = node.w;
        const h = node.h;
        const radius = node.full ? s.cornerRadius : Math.min(s.cornerRadius, Math.min(w, h) / 2);
        refs.g.classList.toggle("he-compact", !node.full);
        setRect(refs.card, 0, 0, w, h, radius);
        setRect(refs.ring, -3, -3, w + 6, h + 6, radius + 3);
        setRect(refs.shadow, 0, 2, w, h, radius);
        if (node.full) {
            refs.card.removeAttribute("fill");
            refs.card.removeAttribute("fill-opacity");
        } else {
            refs.card.setAttribute("fill", this.levelColor(node.depth));
            refs.card.setAttribute("fill-opacity", t.highContrast ? "1" : "0.26");
        }
        if (refs.badge) {
            const horizontal = s.orientation === "horizontal";
            refs.badge.setAttribute("transform", horizontal ? `translate(${round1(w)},${round1(h / 2)})` : `translate(${round1(w / 2)},${round1(h)})`);
            refs.badge.classList.toggle("he-collapsed", !expanded);
        }
    }

    private setShown(node: TreeNode, visible: boolean): void {
        const refs = this.nodeRefs.get(node.id);
        const link = this.linkEls.get(node.id);
        if (visible) {
            this.shown.add(node.id);
        } else {
            this.shown.delete(node.id);
        }
        refs?.g.classList.toggle("he-hidden", !visible);
        link?.classList.toggle("he-hidden", !visible);
    }

    private setFade(node: TreeNode, opacity: number | null): void {
        const refs = this.nodeRefs.get(node.id);
        const link = this.linkEls.get(node.id);
        if (opacity === null) {
            refs?.body.removeAttribute("opacity");
            link?.removeAttribute("stroke-opacity");
        } else {
            refs?.body.setAttribute("opacity", String(round2(opacity)));
            link?.setAttribute("stroke-opacity", String(round2(opacity)));
        }
    }

    private placeNode(node: TreeNode, pos: Box): void {
        const refs = this.nodeRefs.get(node.id);
        if (refs) {
            refs.g.setAttribute("transform", `translate(${round1(pos.x)},${round1(pos.y)})`);
        }
        // Store a copy: the layout mutates node boxes in place.
        this.drawn.set(node.id, { x: pos.x, y: pos.y, w: pos.w, h: pos.h });
    }

    private placeLink(node: TreeNode, parentPos: NodePosition, childPos: NodePosition): void {
        const link = this.linkEls.get(node.id);
        if (!link) {
            return;
        }
        const s = this.settings as ResolvedSettings;
        const d = connectorPath(parentPos, childPos, s.orientation, s.connectorStyle);
        if (this.linkKeys.get(node.id) !== d) {
            this.linkKeys.set(node.id, d);
            link.setAttribute("d", d);
        }
    }

    private ariaLabel(node: TreeNode): string {
        const parts = [`${node.levelName}: ${node.name}`];
        parts.push(`${this.valueLabel} ${this.formatter.full(node.value)}`);
        if (node.children.length > 0) {
            parts.push(`${node.children.length} ${node.children.length === 1 ? "child" : "children"}`);
        }
        return parts.join(", ");
    }

    private buildLevelHeaders(): void {
        const names = [ROOT_LEVEL_NAME, ...this.levelNames];
        this.headerEls = [];
        const fragment = document.createDocumentFragment();
        for (let depth = 0; depth < names.length; depth++) {
            const item = htmlEl("div", "he-level-header");
            const dot = htmlEl("span", "he-level-swatch");
            dot.style.backgroundColor = this.levelColor(depth);
            const label = htmlEl("span", "he-level-label", names[depth] ?? "");
            item.append(dot, label);
            fragment.appendChild(item);
            this.headerEls.push(item);
        }
        this.levelHeadersEl.replaceChildren(fragment);
    }

    /** The vertical level rail needs room; narrow visuals go without it. */
    private showsLevelRail(): boolean {
        const s = this.settings as ResolvedSettings;
        return s.orientation === "vertical" && s.showLevelHeaders && this.canvasSize.width >= 560;
    }

    private updateLevelHeaders(): void {
        if (this.headerEls.length === 0 || !this.settings) {
            return;
        }
        if (this.settings.orientation === "vertical") {
            this.levelHeadersEl.style.visibility = this.showsLevelRail() ? "visible" : "hidden";
        }
        const s = this.settings;
        const horizontal = s.orientation === "horizontal";
        const { width, height } = this.canvasSize;
        const scale = width / this.viewBox.w;
        const mainSize = horizontal ? s.nodeWidth : s.nodeHeight;
        const step = mainSize + s.levelSpacing;
        const limit = horizontal ? width : height;
        for (let depth = 0; depth < this.headerEls.length; depth++) {
            const start = (depth * step - (horizontal ? this.viewBox.x : this.viewBox.y)) * scale;
            const size = mainSize * scale;
            const el = this.headerEls[depth];
            const visible = size >= (horizontal ? 40 : 18) && start + size > 0 && start < limit;
            el.style.display = visible ? "" : "none";
            if (visible) {
                if (horizontal) {
                    el.style.transform = `translateX(${round1(start)}px)`;
                    el.style.width = `${round1(size)}px`;
                } else {
                    el.style.transform = `translateY(${round1(start + size / 2)}px)`;
                    el.style.width = "";
                }
            }
        }
    }

    // ------------------------------------------------------------------ focus

    private focusedNode(): TreeNode | null {
        if (this.focusKey === null || !this.tree) {
            return null;
        }
        return this.tree.byKey.get(this.focusKey) ?? null;
    }

    private restoreFocus(): void {
        const tree = this.tree as Tree;
        if (this.focusKey !== null && !tree.byKey.has(this.focusKey)) {
            // The focused node no longer exists (filters changed). Go back to the overview.
            this.focusKey = null;
            if (this.settings?.crossFilter && this.selectionManager.hasSelection()) {
                this.selectionManager.clear();
            }
        }
        if (this.focusKey === null && this.selectionManager.hasSelection()) {
            // A bookmark or an earlier session may have restored a selection.
            const node = this.nodeFromSelection(this.selectionManager.getSelectionIds() as ISelectionId[]);
            if (node) {
                this.focusKey = node.key;
            }
        }
        const focused = this.focusedNode();
        const cursor = this.nodeById.get(this.cursorId);
        if (!cursor || (focused && !isWithin(cursor, focused))) {
            this.cursorId = focused ? focused.id : tree.root.id;
        }
    }

    private nodeFromSelection(ids: ISelectionId[]): TreeNode | null {
        if (!this.tree || ids.length === 0) {
            return null;
        }
        const keys = new Set(ids.map((id) => id.getKey()));
        return findNodeByRowKeys(this.tree, keys, (rowIndex) => this.rowId(rowIndex)?.getKey());
    }

    private rowId(rowIndex: number): ISelectionId | undefined {
        if (!this.table || rowIndex < 0 || rowIndex >= this.rowIds.length) {
            return undefined;
        }
        let id = this.rowIds[rowIndex];
        if (!id) {
            id = this.host.createSelectionIdBuilder().withTable(this.table, rowIndex).createSelectionId() as ISelectionId;
            this.rowIds[rowIndex] = id;
        }
        return id;
    }

    private nodeIds(node: TreeNode): ISelectionId[] {
        const ids: ISelectionId[] = [];
        for (const r of node.rows) {
            const id = this.rowId(r);
            if (id) {
                ids.push(id);
            }
        }
        return ids;
    }

    /** Change the focused node. null shows the overview. */
    private setFocus(node: TreeNode | null, options: { animate: boolean; select: boolean }): void {
        if (!this.tree) {
            return;
        }
        // Freeze whatever is on screen (possibly mid-animation) as the starting point.
        this.cancelAnimation(true);
        this.focusKey = node && node.parent ? node.key : null;
        const focused = this.focusedNode();
        this.cursorId = focused ? focused.id : this.tree.root.id;

        this.layout();
        for (const n of this.tree.nodes) {
            const refs = this.nodeRefs.get(n.id);
            if (refs) {
                this.applyNodeShape(n, refs);
            }
        }
        this.applyFocusStyles();
        this.updateBreadcrumb();
        this.updateRovingTabIndex();
        if (options.select) {
            this.syncSelection(focused);
        }
        this.renderPanel();
        this.animateTo(this.targetBox(), options.animate, true);
    }

    private syncSelection(focused: TreeNode | null): void {
        if (!this.settings?.crossFilter || !this.allowInteractions) {
            return;
        }
        if (focused) {
            this.selectionManager.select(this.nodeIds(focused), false);
        } else if (this.selectionManager.hasSelection()) {
            this.selectionManager.clear();
        }
    }

    private activate(node: TreeNode): void {
        this.setFocus(nextFocus(this.focusedNode(), node), { animate: true, select: true });
    }

    private stepBack(): void {
        const focused = this.focusedNode();
        if (focused) {
            this.setFocus(stepBackTarget(focused), { animate: true, select: true });
        }
    }

    private applyFocusStyles(): void {
        if (!this.tree) {
            return;
        }
        const focused = this.focusedNode();
        const ancestors = new Set<TreeNode>(focused ? ancestorsOf(focused) : []);
        for (const node of this.tree.nodes) {
            const inFocus = !!focused && isWithin(node, focused);
            const related = !focused || ancestors.has(node) || inFocus;
            const isFocused = node === focused;
            const onPath = isFocused || ancestors.has(node);
            const refs = this.nodeRefs.get(node.id);
            if (refs) {
                const key = `${related ? 1 : 0}${isFocused ? 1 : 0}${onPath ? 1 : 0}`;
                if (refs.styleKey !== key) {
                    refs.styleKey = key;
                    refs.g.classList.toggle("he-dim", !related);
                    refs.g.classList.toggle("he-focused", isFocused);
                    refs.g.classList.toggle("he-on-path", onPath && !isFocused);
                    refs.g.setAttribute("aria-selected", isFocused ? "true" : "false");
                }
            }
            const link = this.linkEls.get(node.id);
            if (link) {
                link.classList.toggle("he-dim", !related);
                link.classList.toggle("he-link-active", (inFocus && !isFocused) || ancestors.has(node) || isFocused);
            }
        }
        this.overviewButton.disabled = !focused;
    }

    private updateRovingTabIndex(): void {
        const previous = this.nodeRefs.get(this.rovingId);
        const next = this.nodeRefs.get(this.cursorId);
        if (previous && previous !== next) {
            previous.g.setAttribute("tabindex", "-1");
        }
        if (next) {
            next.g.setAttribute("tabindex", "0");
        }
        this.rovingId = this.cursorId;
    }

    private updateBreadcrumb(): void {
        if (!this.tree) {
            return;
        }
        const focused = this.focusedNode();
        const trail = focused ? [...ancestorsOf(focused), focused] : [this.tree.root];
        const fragment = document.createDocumentFragment();
        trail.forEach((node, index) => {
            const li = htmlEl("li", "he-crumb");
            if (index === trail.length - 1) {
                const current = htmlEl("span", "he-crumb-current", node.name);
                current.setAttribute("aria-current", "location");
                current.title = node.name;
                li.appendChild(current);
            } else {
                const button = htmlEl("button", "he-crumb-button", node.name);
                button.type = "button";
                button.title = `${node.levelName}: ${node.name}`;
                button.setAttribute("data-node", String(node.id));
                li.appendChild(button);
            }
            fragment.appendChild(li);
        });
        this.breadcrumbList.replaceChildren(fragment);
    }

    // ------------------------------------------------------------------ camera and animation

    /**
     * Measure the drawing area once per update, before the tree DOM changes, so later
     * reads never force the browser to restyle thousands of SVG elements.
     */
    private measureCanvas(): void {
        const rect = this.canvasEl.getBoundingClientRect();
        const elementRect = this.element.getBoundingClientRect();
        this.canvasOffset = { left: rect.left, top: rect.top };
        this.elementOffset = { left: elementRect.left, top: elementRect.top };
        if (rect.width > 0 && rect.height > 0) {
            this.canvasSize = { width: rect.width, height: rect.height };
        } else {
            // Hidden or exporting: estimate from the element size.
            this.canvasSize = {
                width: Math.max(1, this.element.clientWidth),
                height: Math.max(1, this.element.clientHeight - 80),
            };
        }
    }

    /** Space the camera should leave free around the tree: level rail and details panel. */
    private viewInsets(): { left: number; right: number; bottom: number } {
        const left = this.showsLevelRail() ? 96 : 0;
        if (this.panelMode === "right") {
            return { left, right: this.panelSize().width + 24, bottom: 0 };
        }
        if (this.panelMode === "bottom") {
            return { left, right: 0, bottom: this.panelSize().height + 24 };
        }
        return { left, right: 0, bottom: 0 };
    }

    private targetBox(): Box {
        const tree = this.tree as Tree;
        const s = this.settings as ResolvedSettings;
        const { width, height } = this.canvasSize;
        const focused = this.focusedNode();
        const horizontal = s.orientation === "horizontal";
        const inset = this.viewInsets();
        const fitWidth = Math.max(80, width - inset.left - inset.right);
        const fitHeight = Math.max(80, height - inset.bottom);
        let box: Box;
        if (focused) {
            box = fitBox(
                subtreeBox(focused, s.orientation),
                fitWidth,
                fitHeight,
                { orientation: s.orientation, padding: 20, maxScale: 1.25, minScale: 0.45 },
                horizontal ? focused.y + focused.h / 2 : focused.x + focused.w / 2,
            );
        } else {
            const overview = overviewBox(tree, s.overviewLevels);
            // When the overview cannot fit, start where the largest siblings are (they sort first),
            // or on the root in an org chart.
            box = fitBox(
                overview,
                fitWidth,
                fitHeight,
                { orientation: s.orientation, padding: 20, maxScale: 1.1, minScale: 0.45, alignStart: true },
                horizontal ? overview.y : tree.root.x + tree.root.w / 2,
            );
        }
        if (fitWidth !== width || fitHeight !== height) {
            // Keep the zoom, extend the view over the rail and panel areas.
            const scale = fitWidth / box.w;
            box = { x: box.x - inset.left / scale, y: box.y, w: width / scale, h: height / scale };
        }
        return box;
    }

    private applyViewBox(box: Box): void {
        this.viewBox = box;
        this.svg.setAttribute("viewBox", `${round1(box.x)} ${round1(box.y)} ${round1(box.w)} ${round1(box.h)}`);
        this.updateLevelHeaders();
    }

    /**
     * Stop the running animation. Normally nodes snap to their final layout. With
     * `interrupt`, they stay where they are so the next animation continues from mid-flight.
     */
    private cancelAnimation(interrupt = false): void {
        if (this.animationFrame) {
            cancelAnimationFrame(this.animationFrame);
            this.animationFrame = 0;
        }
        const finish = this.finishAnimation;
        const stop = this.interruptAnimation;
        this.finishAnimation = null;
        this.interruptAnimation = null;
        if (interrupt) {
            stop?.();
        } else {
            finish?.();
        }
    }

    private motionAllowed(): boolean {
        const s = this.settings as ResolvedSettings;
        if (s.animationDuration <= 0) {
            return false;
        }
        if (s.respectReducedMotion && typeof window.matchMedia === "function") {
            return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        }
        return true;
    }

    /**
     * Move the camera to `target` along a smooth zoom path. With `moveNodes`, nodes travel
     * from where they are drawn now to their new layout in the same frames: they slide,
     * branches that open grow out of their parent and fade in, branches that close fold
     * back into their parent and fade out.
     */
    private animateTo(target: Box, animate: boolean, moveNodes = false): void {
        this.cancelAnimation();
        const tree = this.tree;
        const motions: Motion[] = [];
        if (tree && moveNodes) {
            for (const node of tree.nodes) {
                const wasShown = this.shown.has(node.id);
                const willShow = !node.hidden;
                if (!wasShown && !willShow) {
                    continue;
                }
                const now = this.drawn.get(node.id) ?? node;
                if (wasShown && willShow) {
                    if (now.x !== node.x || now.y !== node.y) {
                        motions.push({ node, from: now, to: { x: node.x, y: node.y, w: node.w, h: node.h }, fade: null });
                    }
                } else if (willShow) {
                    // Grow out of the nearest ancestor that is on screen.
                    const anchor = this.nearestShownAncestor(node);
                    const origin = anchor ? this.drawn.get(anchor.id) ?? anchor : node;
                    const from = this.centredOn(node, origin);
                    motions.push({ node, from, to: { x: node.x, y: node.y, w: node.w, h: node.h }, fade: "in" });
                } else {
                    // Fold back into the nearest ancestor that stays on screen.
                    const anchor = this.nearestVisibleAncestor(node);
                    const to = anchor ? this.centredOn(node, anchor, now) : now;
                    motions.push({ node, from: now, to, fade: "out" });
                }
            }
        }

        const animateNodes = motions.length > 0 && motions.length <= MAX_ANIMATED_NODES;
        const byId = new Map<number, Motion>(motions.map((m) => [m.node.id, m]));

        const frame = (e: number) => {
            if (motions.length === 0) {
                return;
            }
            const positions = new Map<number, Box>();
            const positionOf = (node: TreeNode): Box => {
                let pos = positions.get(node.id);
                if (!pos) {
                    const motion = byId.get(node.id);
                    pos = motion ? lerpBox(motion.from, motion.to, e) : this.drawn.get(node.id) ?? node;
                    positions.set(node.id, pos);
                }
                return pos;
            };
            for (const motion of motions) {
                const node = motion.node;
                this.placeNode(node, positionOf(node));
                if (motion.fade) {
                    this.setFade(node, motion.fade === "in" ? e : 1 - e);
                }
                if (node.parent) {
                    this.placeLink(node, positionOf(node.parent), positionOf(node));
                }
                for (const child of node.children) {
                    if (this.shown.has(child.id) || byId.has(child.id)) {
                        this.placeLink(child, positionOf(node), positionOf(child));
                    }
                }
            }
        };

        const interrupt = () => {
            // Nodes that were fading keep their place and become fully visible; the next
            // layout decides whether they stay.
            for (const motion of motions) {
                if (motion.fade) {
                    this.setFade(motion.node, null);
                }
            }
        };

        const finish = () => {
            frame(1);
            for (const motion of motions) {
                if (motion.fade === "out") {
                    this.setShown(motion.node, false);
                    this.placeNode(motion.node, motion.node);
                }
                if (motion.fade) {
                    this.setFade(motion.node, null);
                }
            }
        };

        // Make appearing nodes visible (transparent) before the first frame.
        for (const motion of motions) {
            if (motion.fade === "in") {
                this.setShown(motion.node, true);
                this.setFade(motion.node, animateNodes ? 0 : 1);
            }
        }

        if (!animate || !this.motionAllowed()) {
            finish();
            this.applyViewBox(target);
            return;
        }
        if (!animateNodes) {
            finish();
        }

        const path = zoomPath(this.viewBox, target);
        const base = (this.settings as ResolvedSettings).animationDuration;
        const duration = base * Math.min(1.4, Math.max(0.9, 0.85 + path.length * 0.25));
        const start = performance.now();
        this.finishAnimation = animateNodes ? finish : null;
        this.interruptAnimation = animateNodes ? interrupt : null;
        const step = (now: number) => {
            const t = Math.min(1, (now - start) / duration);
            const e = easeInOutCubic(t);
            if (animateNodes) {
                frame(e);
            }
            this.applyViewBox(path.at(e));
            if (t < 1) {
                this.animationFrame = requestAnimationFrame(step);
            } else {
                this.animationFrame = 0;
                const done = this.finishAnimation;
                this.finishAnimation = null;
                this.interruptAnimation = null;
                done?.();
            }
        };
        this.animationFrame = requestAnimationFrame(step);
    }

    private nearestShownAncestor(node: TreeNode): TreeNode | null {
        let current = node.parent;
        while (current && !this.shown.has(current.id)) {
            current = current.parent;
        }
        return current;
    }

    private nearestVisibleAncestor(node: TreeNode): TreeNode | null {
        let current = node.parent;
        while (current && current.hidden) {
            current = current.parent;
        }
        return current;
    }

    /** A box of `node`'s size centred on the outgoing edge of `anchor`. */
    private centredOn(node: TreeNode, anchor: Box, size: Box = node): Box {
        const horizontal = (this.settings as ResolvedSettings).orientation === "horizontal";
        return horizontal
            ? { x: anchor.x + anchor.w - size.w * 0.5, y: anchor.y + anchor.h / 2 - size.h / 2, w: size.w, h: size.h }
            : { x: anchor.x + anchor.w / 2 - size.w / 2, y: anchor.y + anchor.h - size.h * 0.5, w: size.w, h: size.h };
    }

    private zoomBy(factor: number): void {
        if (!this.tree) {
            return;
        }
        const vb = this.viewBox;
        const w = Math.min(this.canvasSize.width / MIN_ZOOM, Math.max(this.canvasSize.width / MAX_ZOOM, vb.w / factor));
        const h = w * (vb.h / vb.w);
        this.animateTo({ x: vb.x + vb.w / 2 - w / 2, y: vb.y + vb.h / 2 - h / 2, w, h }, true);
    }

    /** Pan without zooming so that a node is visible, used by keyboard navigation. */
    private ensureVisible(node: TreeNode): void {
        const vb = this.viewBox;
        const inside = node.x >= vb.x && node.x + node.w <= vb.x + vb.w && node.y >= vb.y && node.y + node.h <= vb.y + vb.h;
        if (inside || node.hidden) {
            return;
        }
        this.animateTo({ x: node.x + node.w / 2 - vb.w / 2, y: node.y + node.h / 2 - vb.h / 2, w: vb.w, h: vb.h }, true);
    }

    // ------------------------------------------------------------------ details panel

    private detailsOf(node: TreeNode): DetailEntry[] {
        let entries = this.detailCache.get(node.id);
        if (!entries) {
            entries = collectDetails(this.table?.rows ?? [], node.rows, this.detailColumns);
            this.detailCache.set(node.id, entries);
        }
        return entries;
    }

    private panelSize(): { width: number; height: number } {
        const s = this.settings as ResolvedSettings;
        const { width, height } = this.canvasSize;
        return {
            width: Math.min(s.panelWidth, Math.max(200, width - 140)),
            height: Math.min(280, Math.round(height * 0.5)),
        };
    }

    private togglePanel(): void {
        const focused = this.focusedNode();
        if (!focused) {
            return;
        }
        this.panelDismissedKey = this.panelDismissedKey === focused.key ? null : focused.key;
        this.renderPanel();
        this.animateTo(this.targetBox(), true);
    }

    /** Show the details of the node you have entered, or hide the panel. */
    private renderPanel(): void {
        const s = this.settings as ResolvedSettings;
        const focused = this.focusedNode();
        const open = !!focused && s.showDetails && this.panelDismissedKey !== focused.key;
        if (this.panelDismissedKey !== null && (!focused || focused.key !== this.panelDismissedKey)) {
            this.panelDismissedKey = null;
        }
        const narrow = this.canvasSize.width < 560;
        this.panelMode = open ? (narrow ? "bottom" : "right") : "none";
        this.rootEl.classList.toggle("he-panel-open", open);
        if (open) {
            // The placement class stays after closing, so the panel slides out the way it came in.
            this.rootEl.classList.toggle("he-panel-right", this.panelMode === "right");
            this.rootEl.classList.toggle("he-panel-bottom", this.panelMode === "bottom");
        }
        const size = this.panelSize();
        this.rootEl.style.setProperty("--he-panel-width", `${size.width}px`);
        this.rootEl.style.setProperty("--he-panel-height", `${size.height}px`);
        this.panelEl.setAttribute("aria-hidden", open ? "false" : "true");
        if (!open || !focused) {
            // Keep the old content while the panel slides away.
            this.panelEl.querySelectorAll("button").forEach((b) => b.setAttribute("tabindex", "-1"));
            return;
        }
        this.panelEl.replaceChildren(this.buildPanelContent(focused));
    }

    private buildPanelContent(node: TreeNode): DocumentFragment {
        const s = this.settings as ResolvedSettings;
        const fragment = document.createDocumentFragment();

        // Header: avatar, name, level and path.
        const head = htmlEl("div", "he-panel-head");
        if (s.showAvatar) {
            const avatar = htmlEl("div", "he-panel-avatar", initialsOf(node.name));
            avatar.style.backgroundColor = this.levelColor(node.depth);
            avatar.setAttribute("aria-hidden", "true");
            head.appendChild(avatar);
        }
        const titles = htmlEl("div", "he-panel-titles");
        const name = htmlEl("div", "he-panel-name", node.name);
        name.setAttribute("role", "heading");
        name.setAttribute("aria-level", "3");
        name.title = node.name;
        const level = htmlEl("div", "he-panel-level", node.levelName);
        titles.append(name, level);
        const ancestors = ancestorsOf(node).filter((a) => a.parent);
        if (ancestors.length > 0) {
            titles.appendChild(htmlEl("div", "he-panel-path", ancestors.map((a) => a.name).join(" › ")));
        }
        const close = htmlEl("button", "he-panel-close");
        close.type = "button";
        close.title = "Close details";
        close.setAttribute("aria-label", "Close details");
        close.setAttribute("data-action", "close");
        close.appendChild(icon(["M4 4l8 8", "M12 4l-8 8"]));
        head.append(titles, close);
        fragment.appendChild(head);

        // Key figures.
        const figures = htmlEl("dl", "he-panel-figures");
        const addFigure = (label: string, value: string) => {
            const row = htmlEl("div", "he-panel-figure");
            row.append(htmlEl("dt", undefined, label), htmlEl("dd", undefined, value));
            figures.appendChild(row);
        };
        addFigure(this.valueLabel, this.formatter.full(node.value));
        if (node.parent && node.parent.value > 0 && node.value >= 0) {
            addFigure(`Share of ${node.parent.name}`, this.shareFormatter.full(node.value / node.parent.value));
        }
        if (this.hasMeasure && node.children.length > 0) {
            addFigure("Rows", node.rowCount.toLocaleString(this.host.locale));
        }
        this.extraColumns.forEach((column, index) => addFigure(column.name, column.formatter.full(node.extras[index] ?? 0)));
        fragment.appendChild(figures);

        // Details from the Details field well.
        const entries = this.detailsOf(node);
        if (entries.length > 0) {
            const section = htmlEl("section", "he-panel-section");
            section.appendChild(htmlEl("div", "he-panel-heading", "Details"));
            const list = htmlEl("dl", "he-panel-details");
            for (const entry of entries) {
                const row = htmlEl("div", "he-panel-detail");
                const dd = htmlEl("dd");
                const text = summarizeDetail(entry);
                if (entry.distinct === 1 && isWebLink(text)) {
                    const link = htmlEl("button", "he-panel-link", text);
                    link.type = "button";
                    link.setAttribute("data-url", text);
                    link.title = "Open in a new tab";
                    dd.appendChild(link);
                } else {
                    dd.textContent = text;
                    if (entry.distinct > 1 && entry.distinct <= 3) {
                        dd.classList.add("he-panel-multi");
                    } else if (entry.distinct > 3) {
                        dd.classList.add("he-panel-muted");
                    }
                }
                dd.title = entry.distinct > 1 ? entry.values.join(", ") + (entry.distinct > entry.values.length ? ", …" : "") : text;
                row.append(htmlEl("dt", undefined, entry.label), dd);
                list.appendChild(row);
            }
            section.appendChild(list);
            fragment.appendChild(section);
        }

        // Children, so you can walk the tree from the panel.
        if (s.showChildren && node.children.length > 0) {
            const section = htmlEl("section", "he-panel-section");
            const childLevel = node.children[0].levelName;
            section.appendChild(htmlEl("div", "he-panel-heading", `${childLevel} (${node.children.length})`));
            const list = htmlEl("ul", "he-panel-children");
            const limit = 60;
            for (const child of node.children.slice(0, limit)) {
                const li = htmlEl("li");
                const button = htmlEl("button", "he-panel-child");
                button.type = "button";
                button.setAttribute("data-node", String(child.id));
                button.title = `Open ${child.name}`;
                const dot = htmlEl("span", "he-panel-child-dot");
                dot.style.backgroundColor = this.levelColor(child.depth);
                const label = htmlEl("span", "he-panel-child-name", child.name);
                const value = htmlEl("span", "he-panel-child-value", this.formatter.compact(child.value));
                button.append(dot, label, value);
                li.appendChild(button);
                list.appendChild(li);
            }
            section.appendChild(list);
            if (node.children.length > limit) {
                section.appendChild(htmlEl("div", "he-panel-more", `and ${node.children.length - limit} more`));
            }
            fragment.appendChild(section);
        }
        return fragment;
    }

    private onPanelClick(event: MouseEvent): void {
        const target = event.target as Element | null;
        const button = target?.closest?.("button");
        if (!button) {
            return;
        }
        if (button.getAttribute("data-action") === "close") {
            this.togglePanel();
            return;
        }
        const url = button.getAttribute("data-url");
        if (url) {
            this.host.launchUrl(url);
            return;
        }
        const node = this.nodeById.get(Number(button.getAttribute("data-node")));
        if (node && this.allowInteractions) {
            this.setFocus(node, { animate: true, select: true });
        }
    }

    // ------------------------------------------------------------------ events

    private nodeFromEvent(event: Event): TreeNode | null {
        const target = event.target as Element | null;
        const g = target?.closest?.(".he-node");
        if (!g) {
            return null;
        }
        return this.nodeById.get(Number(g.getAttribute("data-id"))) ?? null;
    }

    private bindEvents(): void {
        this.overviewButton.addEventListener("click", () => {
            if (this.tree) {
                this.setFocus(null, { animate: true, select: true });
            }
        });

        this.breadcrumbList.addEventListener("click", (event) => {
            const button = (event.target as Element | null)?.closest?.(".he-crumb-button");
            if (!button || !this.tree) {
                return;
            }
            const node = this.nodeById.get(Number(button.getAttribute("data-node")));
            if (node) {
                this.setFocus(node.parent ? node : null, { animate: true, select: true });
            }
        });

        this.svg.addEventListener("click", (event) => {
            if (this.suppressClick) {
                this.suppressClick = false;
                return;
            }
            if (!this.tree || !this.allowInteractions) {
                return;
            }
            const node = this.nodeFromEvent(event);
            if (node) {
                this.activate(node);
            } else if (this.settings?.canvasNavigation) {
                this.stepBack();
            }
        });

        this.svg.addEventListener("keydown", (event) => this.onKeyDown(event));

        this.svg.addEventListener("contextmenu", (event) => {
            event.preventDefault();
            this.showContextMenu(this.nodeFromEvent(event), event.clientX, event.clientY);
        });

        this.svg.addEventListener("pointermove", (event) => {
            this.onPan(event);
            if (this.pan?.moved) {
                return;
            }
            const node = this.nodeFromEvent(event);
            if (node) {
                this.showTooltip(node, event);
            } else {
                this.hideTooltip();
            }
        });
        this.svg.addEventListener("pointerleave", () => this.hideTooltip());
        this.svg.addEventListener("pointerdown", (event) => this.onPanStart(event));
        this.svg.addEventListener("pointerup", (event) => this.onPanEnd(event));
        this.svg.addEventListener("pointercancel", (event) => this.onPanEnd(event));
        this.svg.addEventListener("wheel", (event) => this.onWheel(event), { passive: false });

        this.selectionManager.registerOnSelectCallback((selected: powerbi.extensibility.ISelectionId[]) => {
            // Bookmarks and other selection restores.
            if (this.tree) {
                this.setFocus(this.nodeFromSelection(selected as ISelectionId[]), { animate: true, select: false });
            }
        });
    }

    private onKeyDown(event: KeyboardEvent): void {
        if (!this.tree) {
            return;
        }
        const node = this.nodeFromEvent(event) ?? this.nodeById.get(this.cursorId) ?? null;
        if (!node) {
            return;
        }
        const horizontal = this.settings?.orientation !== "vertical";
        const deeper = horizontal ? "ArrowRight" : "ArrowDown";
        const shallower = horizontal ? "ArrowLeft" : "ArrowUp";
        const nextSibling = horizontal ? "ArrowDown" : "ArrowRight";
        const previousSibling = horizontal ? "ArrowUp" : "ArrowLeft";
        let next: TreeNode | null | undefined = null;
        switch (event.key) {
            case "Enter":
            case " ":
                if (this.allowInteractions) {
                    this.activate(node);
                }
                break;
            case "Escape":
                if (!this.focusedNode()) {
                    return;
                }
                this.stepBack();
                break;
            case deeper:
                next = node.children.find((c) => !c.hidden);
                if (!next && node.children.length > 0 && this.allowInteractions) {
                    // Entering a collapsed branch from the keyboard opens it first.
                    this.activate(node);
                    next = node.children[0];
                }
                break;
            case shallower:
                next = node.parent;
                break;
            case nextSibling:
            case previousSibling: {
                const siblings = node.parent?.children ?? [];
                const index = siblings.indexOf(node);
                next = siblings[index + (event.key === nextSibling ? 1 : -1)];
                break;
            }
            case "Home":
                next = this.tree.root;
                break;
            case "i":
            case "I":
                this.togglePanel();
                break;
            case "ContextMenu":
            case "F10":
                if (event.key === "F10" && !event.shiftKey) {
                    return;
                }
                this.showContextMenuForNode(node);
                break;
            default:
                return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (next && !next.hidden) {
            this.moveCursor(next);
        } else if (event.key === "Enter" || event.key === " " || event.key === "Escape") {
            this.nodeRefs.get(this.cursorId)?.g.focus();
        }
    }

    private moveCursor(node: TreeNode): void {
        this.cursorId = node.id;
        this.updateRovingTabIndex();
        this.nodeRefs.get(node.id)?.g.focus({ preventScroll: true });
        this.ensureVisible(node);
    }

    private showContextMenuForNode(node: TreeNode): void {
        const rect = this.nodeRefs.get(node.id)?.g.getBoundingClientRect();
        this.showContextMenu(node, rect ? rect.left + rect.width / 2 : 0, rect ? rect.top + rect.height / 2 : 0);
    }

    private showContextMenu(node: TreeNode | null, x: number, y: number): void {
        const id = node && node.parent && node.rows.length > 0 ? this.rowId(node.rows[0]) : undefined;
        this.selectionManager.showContextMenu(id ?? ({} as ISelectionId), { x, y });
    }

    private tooltipItems(node: TreeNode): VisualTooltipDataItem[] {
        const items: VisualTooltipDataItem[] = [
            { displayName: node.levelName, value: node.name },
            { displayName: this.valueLabel, value: this.formatter.full(node.value) },
        ];
        if (node.parent && node.parent.value > 0 && node.value >= 0) {
            items.push({ displayName: `Share of ${node.parent.name}`, value: this.shareFormatter.full(node.value / node.parent.value) });
        }
        if (this.hasMeasure) {
            items.push({ displayName: "Rows", value: node.rowCount.toLocaleString(this.host.locale) });
        }
        this.extraColumns.forEach((column, index) => {
            items.push({ displayName: column.name, value: column.formatter.full(node.extras[index] ?? 0) });
        });
        if (this.settings?.detailsInTooltip && node.parent && node.rows.length <= 5000) {
            for (const entry of this.detailsOf(node)) {
                if (entry.distinct === 1) {
                    items.push({ displayName: entry.label, value: entry.values[0] });
                }
            }
        }
        if (node.children.length > 0) {
            items.push({ displayName: "Children", value: String(node.children.length) });
        }
        const path = ancestorsOf(node).filter((a) => a.parent);
        if (path.length > 0) {
            items.push({ displayName: "Path", value: path.map((a) => a.name).join(" › ") });
        }
        return items;
    }

    private showTooltip(node: TreeNode, event: PointerEvent): void {
        this.tooltipService.show({
            coordinates: [event.clientX - this.elementOffset.left, event.clientY - this.elementOffset.top],
            dataItems: this.tooltipItems(node),
            // Identities let report page tooltips filter to this node. Capped to keep hover fast.
            identities: node.parent && node.rows.length <= MAX_TOOLTIP_IDENTITIES ? this.nodeIds(node) : [],
            isTouchEvent: event.pointerType === "touch",
        });
    }

    private hideTooltip(): void {
        this.tooltipService.hide({ immediately: true, isTouchEvent: false });
    }

    private onPanStart(event: PointerEvent): void {
        if (event.button !== 0 || !this.tree) {
            return;
        }
        this.pan = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, startBox: { ...this.viewBox }, moved: false };
    }

    private onPan(event: PointerEvent): void {
        const pan = this.pan;
        if (!pan || pan.pointerId !== event.pointerId) {
            return;
        }
        const dx = event.clientX - pan.startX;
        const dy = event.clientY - pan.startY;
        if (!pan.moved && Math.hypot(dx, dy) < PAN_THRESHOLD) {
            return;
        }
        if (!pan.moved) {
            pan.moved = true;
            this.cancelAnimation();
            pan.startBox = { ...this.viewBox };
            this.hideTooltip();
            this.svg.classList.add("he-panning");
            try {
                this.svg.setPointerCapture(event.pointerId);
            } catch {
                // Pointer capture is optional.
            }
        }
        const scale = this.canvasSize.width / pan.startBox.w;
        this.applyViewBox({ ...pan.startBox, x: pan.startBox.x - dx / scale, y: pan.startBox.y - dy / scale });
    }

    private onPanEnd(event: PointerEvent): void {
        const pan = this.pan;
        if (!pan || pan.pointerId !== event.pointerId) {
            return;
        }
        if (pan.moved) {
            this.suppressClick = true;
            this.svg.classList.remove("he-panning");
            try {
                this.svg.releasePointerCapture(event.pointerId);
            } catch {
                // Ignore.
            }
        }
        this.pan = null;
    }

    private onWheel(event: WheelEvent): void {
        if (!this.tree) {
            return;
        }
        event.preventDefault();
        this.cancelAnimation();
        const { width, height } = this.canvasSize;
        const vb = this.viewBox;
        const scale = width / vb.w;
        const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
        const newScale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale * Math.exp(-delta * 0.0015)));
        const px = event.clientX - this.canvasOffset.left;
        const py = event.clientY - this.canvasOffset.top;
        const ux = vb.x + px / scale;
        const uy = vb.y + py / scale;
        this.applyViewBox({ x: ux - px / newScale, y: uy - py / newScale, w: width / newScale, h: height / newScale });
    }
}

/** Formats a Details cell: numbers with the column's format, dates in the report locale, text as is. */
function detailFormatter(column: powerbi.DataViewMetadataColumn, locale: string): (value: unknown) => string | null {
    const numeric = !!column.type?.numeric || !!column.type?.integer;
    const formatter = numeric ? createValueFormatter(column.format, locale, !!column.type?.integer) : null;
    return (value: unknown) => {
        if (value === null || value === undefined || value === "") {
            return null;
        }
        if (value instanceof Date) {
            return isNaN(value.getTime()) ? null : value.toLocaleDateString(locale);
        }
        if (typeof value === "number") {
            return formatter ? formatter.full(value) : String(value);
        }
        const text = String(value).trim();
        return text.length > 0 ? text : null;
    };
}

/** Share of the parent's value, or 0 when it cannot be expressed as a share. */
function shareOf(node: TreeNode): number {
    const parent = node.parent;
    if (!parent || parent.value <= 0 || node.value <= 0) {
        return 0;
    }
    return Math.min(1, node.value / parent.value);
}

/** Cheap fingerprint of a table, so identical host updates can be ignored. */
function signatureOf(table: DataViewTable): string {
    let hash = 0x811c9dc5;
    const mix = (text: string) => {
        for (let i = 0; i < text.length; i++) {
            hash ^= text.charCodeAt(i);
            hash = Math.imul(hash, 0x01000193);
        }
        hash ^= 0x1f;
        hash = Math.imul(hash, 0x01000193);
    };
    for (const column of table.columns) {
        mix(`${column.queryName ?? column.displayName}|${Object.keys(column.roles ?? {}).join(",")}|${column.format ?? ""}`);
    }
    const rows = table.rows ?? [];
    for (const row of rows) {
        for (const value of row) {
            mix(value instanceof Date ? String(value.getTime()) : String(value));
        }
    }
    return `${rows.length}:${table.columns.length}:${(hash >>> 0).toString(36)}`;
}

/** Lighten (positive) or darken (negative) a hex color. Non-hex input is returned unchanged. */
function shade(hex: string, amount: number): string {
    const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!match) {
        return hex;
    }
    const n = parseInt(match[1], 16);
    const channel = (c: number) => Math.round(amount < 0 ? c * (1 + amount) : c + (255 - c) * amount);
    const r = channel((n >> 16) & 255);
    const g = channel((n >> 8) & 255);
    const b = channel(n & 255);
    return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/** Position of a column inside a data role's field well, when the host provides it. */
function rolePosition(column: powerbi.DataViewMetadataColumn, role: string): number | undefined {
    const rolesIndex = (column as { rolesIndex?: { [role: string]: number[] } }).rolesIndex;
    return rolesIndex?.[role]?.[0];
}

function setRect(rect: SVGRectElement, x: number, y: number, w: number, h: number, r: number): void {
    rect.setAttribute("x", String(round1(x)));
    rect.setAttribute("y", String(round1(y)));
    rect.setAttribute("width", String(round1(Math.max(0, w))));
    rect.setAttribute("height", String(round1(Math.max(0, h))));
    const radius = Math.max(0, Math.min(r, w / 2, h / 2));
    rect.setAttribute("rx", String(round1(radius)));
    rect.setAttribute("ry", String(round1(radius)));
}

function round1(n: number): number {
    return Math.round(n * 10) / 10;
}

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}
