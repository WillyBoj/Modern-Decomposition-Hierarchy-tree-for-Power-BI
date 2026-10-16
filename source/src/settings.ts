/*
 *  Hierarchy Explorer – Power BI custom visual
 *  Format pane model (modern getFormattingModel API).
 *  Every slice name below matches a property in capabilities.json.
 */

"use strict";

import powerbi from "powerbi-visuals-api";
import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";

import FormattingSettingsCard = formattingSettings.SimpleCard;
import FormattingSettingsSlice = formattingSettings.Slice;
import FormattingSettingsModel = formattingSettings.Model;

/** Numeric limits shared by the format pane validators and the runtime clamp. */
export const LIMITS = {
    fontSize: { min: 7, max: 20 },
    nodeWidth: { min: 80, max: 400 },
    nodeHeight: { min: 32, max: 120 },
    cornerRadius: { min: 0, max: 24 },
    levelSpacing: { min: 16, max: 300 },
    siblingSpacing: { min: 2, max: 120 },
    overviewLevels: { min: 1, max: 8 },
    animationDuration: { min: 0, max: 2000 },
    dimOpacity: { min: 5, max: 100 },
    panelWidth: { min: 220, max: 480 },
} as const;

type LimitKey = keyof typeof LIMITS;

function numberSlice(name: LimitKey, displayName: string, value: number, unit?: string): formattingSettings.NumUpDown {
    return new formattingSettings.NumUpDown({
        name,
        displayName,
        value,
        options: {
            // ValidatorType is a const enum: Min = 0, Max = 1.
            minValue: { type: 0 as powerbi.visuals.ValidatorType.Min, value: LIMITS[name].min },
            maxValue: { type: 1 as powerbi.visuals.ValidatorType.Max, value: LIMITS[name].max },
            unitSymbol: unit,
        },
    });
}

function color(name: string, displayName: string, value: string): formattingSettings.ColorPicker {
    return new formattingSettings.ColorPicker({ name, displayName, value: { value } });
}

function toggle(name: string, displayName: string, value: boolean): formattingSettings.ToggleSwitch {
    return new formattingSettings.ToggleSwitch({ name, displayName, value });
}

function dropdown(name: string, displayName: string, items: powerbi.IEnumMember[]): formattingSettings.ItemDropdown {
    return new formattingSettings.ItemDropdown({ name, displayName, items, value: items[0] });
}

export const ORIENTATION_ITEMS: powerbi.IEnumMember[] = [
    { value: "horizontal", displayName: "Horizontal (left to right)" },
    { value: "vertical", displayName: "Vertical (org chart)" },
];

export const COLLAPSE_ITEMS: powerbi.IEnumMember[] = [
    { value: "auto", displayName: "Automatic" },
    { value: "compressed", displayName: "Show as compressed bars" },
    { value: "hidden", displayName: "Hide until entered" },
];

export const CONNECTOR_ITEMS: powerbi.IEnumMember[] = [
    { value: "auto", displayName: "Automatic" },
    { value: "curved", displayName: "Curved" },
    { value: "elbow", displayName: "Elbow" },
];

class TitleCard extends FormattingSettingsCard {
    show = toggle("show", "Show title", true);
    text = new formattingSettings.TextInput({
        name: "text",
        displayName: "Title text",
        value: "",
        placeholder: "Defaults to the hierarchy field names",
    });
    subtitle = new formattingSettings.TextInput({
        name: "subtitle",
        displayName: "Subtitle text",
        value: "",
        placeholder: "Optional",
    });
    fontColor = color("fontColor", "Font color", "#1D2433");

    name = "title";
    displayName = "Title";
    topLevelSlice = this.show;
    slices: FormattingSettingsSlice[] = [this.text, this.subtitle, this.fontColor];
}

class NodesCard extends FormattingSettingsCard {
    fontColor = color("fontColor", "Font color", "#1D2433");
    fontSize = numberSlice("fontSize", "Font size", 10, "pt");
    nodeWidth = numberSlice("nodeWidth", "Node width", 184, "px");
    nodeHeight = numberSlice("nodeHeight", "Node height", 58, "px");
    cornerRadius = numberSlice("cornerRadius", "Corner radius", 10, "px");
    showValues = toggle("showValues", "Show values", true);
    showLevelNames = toggle("showLevelNames", "Show level names", true);
    showShareBar = toggle("showShareBar", "Show share of parent bar", true);
    showInitials = toggle("showInitials", "Show initials", false);

    name = "nodes";
    displayName = "Nodes";
    slices: FormattingSettingsSlice[] = [
        this.fontColor,
        this.fontSize,
        this.nodeWidth,
        this.nodeHeight,
        this.cornerRadius,
        this.showValues,
        this.showLevelNames,
        this.showShareBar,
        this.showInitials,
    ];
}

class ColorsCard extends FormattingSettingsCard {
    rootColor = color("rootColor", "Root color", "#3D4A63");
    level1Color = color("level1Color", "First-level color", "#3366E0");
    level2Color = color("level2Color", "Second-level color", "#0F9D8A");
    deeperColor = color("deeperColor", "Deeper-level color", "#8657E0");
    selectedColor = color("selectedColor", "Selected outline color", "#F0A23B");
    connectorColor = color("connectorColor", "Connector color", "#C3CAD5");
    backgroundColor = color("backgroundColor", "Canvas background", "#F4F6F9");

    name = "colors";
    displayName = "Colors";
    slices: FormattingSettingsSlice[] = [
        this.rootColor,
        this.level1Color,
        this.level2Color,
        this.deeperColor,
        this.selectedColor,
        this.connectorColor,
        this.backgroundColor,
    ];
}

class LayoutCard extends FormattingSettingsCard {
    orientation = dropdown("orientation", "Orientation", ORIENTATION_ITEMS);
    collapsedBranches = dropdown("collapsedBranches", "Branches you have not entered", COLLAPSE_ITEMS);
    connectorStyle = dropdown("connectorStyle", "Connector style", CONNECTOR_ITEMS);
    levelSpacing = numberSlice("levelSpacing", "Spacing between levels", 56, "px");
    siblingSpacing = numberSlice("siblingSpacing", "Spacing between siblings", 12, "px");
    overviewLevels = numberSlice("overviewLevels", "Levels in overview", 1);
    animationDuration = numberSlice("animationDuration", "Animation duration", 650, "ms");
    showLevelHeaders = toggle("showLevelHeaders", "Show level headers", true);
    showBreadcrumb = toggle("showBreadcrumb", "Show breadcrumb", true);
    showZoomControls = toggle("showZoomControls", "Show zoom buttons", true);

    name = "layout";
    displayName = "Layout";
    slices: FormattingSettingsSlice[] = [
        this.orientation,
        this.collapsedBranches,
        this.connectorStyle,
        this.levelSpacing,
        this.siblingSpacing,
        this.overviewLevels,
        this.animationDuration,
        this.showLevelHeaders,
        this.showBreadcrumb,
        this.showZoomControls,
    ];
}

class InteractionCard extends FormattingSettingsCard {
    crossFilter = toggle("crossFilter", "Filter other visuals", true);
    dimOpacity = numberSlice("dimOpacity", "Unrelated branch opacity", 30, "%");
    canvasNavigation = toggle("canvasNavigation", "Click empty canvas to go back", true);
    respectReducedMotion = toggle("respectReducedMotion", "Turn off animation when the system asks for reduced motion", false);

    name = "interaction";
    displayName = "Interaction";
    slices: FormattingSettingsSlice[] = [this.crossFilter, this.dimOpacity, this.canvasNavigation, this.respectReducedMotion];
}

class DetailsCard extends FormattingSettingsCard {
    show = toggle("show", "Show details panel", true);
    panelWidth = numberSlice("panelWidth", "Panel width", 330, "px");
    showAvatar = toggle("showAvatar", "Show initials", true);
    showChildren = toggle("showChildren", "List children", true);
    showInTooltip = toggle("showInTooltip", "Add details to tooltip", true);

    name = "details";
    displayName = "Details panel";
    topLevelSlice = this.show;
    slices: FormattingSettingsSlice[] = [this.panelWidth, this.showAvatar, this.showChildren, this.showInTooltip];
}

export class VisualFormattingSettingsModel extends FormattingSettingsModel {
    title = new TitleCard();
    nodes = new NodesCard();
    colors = new ColorsCard();
    layout = new LayoutCard();
    interaction = new InteractionCard();
    details = new DetailsCard();

    cards = [this.title, this.nodes, this.colors, this.layout, this.details, this.interaction];
}

/** Clamp a numeric setting to its declared limits, falling back to a default for NaN. */
export function clampSetting(name: LimitKey, value: number | undefined, fallback: number): number {
    const v = typeof value === "number" && isFinite(value) ? value : fallback;
    return Math.min(LIMITS[name].max, Math.max(LIMITS[name].min, v));
}

/** Read an enumeration value from a dropdown slice, with a fallback for unknown values. */
export function enumValue<T extends string>(slice: formattingSettings.ItemDropdown, allowed: readonly T[], fallback: T): T {
    const raw = slice.value?.value;
    return typeof raw === "string" && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}
