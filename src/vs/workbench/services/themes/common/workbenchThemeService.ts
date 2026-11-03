/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { refineServiceDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { Color } from '../../../../base/common/color.js';
import { IColorTheme, IThemeService, IFileIconTheme, IProductIconTheme } from '../../../../platform/theme/common/themeService.js';
import { ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { isBoolean, isString } from '../../../../base/common/types.js';
import { IconContribution, IconDefinition } from '../../../../platform/theme/common/iconRegistry.js';
import { ColorScheme, ThemeTypeSelector } from '../../../../platform/theme/common/theme.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';

export const IWorkbenchThemeService = refineServiceDecorator<IThemeService, IWorkbenchThemeService>(IThemeService);

export const THEME_SCOPE_OPEN_PAREN = '[';
export const THEME_SCOPE_CLOSE_PAREN = ']';
export const THEME_SCOPE_WILDCARD = '*';

export const themeScopeRegex = /\[(.+?)\]/g;

export enum ThemeSettings {
	COLOR_THEME = 'workbench.colorTheme',
	FILE_ICON_THEME = 'workbench.iconTheme',
	PRODUCT_ICON_THEME = 'workbench.productIconTheme',
	COLOR_CUSTOMIZATIONS = 'workbench.colorCustomizations',
	TOKEN_COLOR_CUSTOMIZATIONS = 'editor.tokenColorCustomizations',
	SEMANTIC_TOKEN_COLOR_CUSTOMIZATIONS = 'editor.semanticTokenColorCustomizations',

	PREFERRED_DARK_THEME = 'workbench.preferredDarkColorTheme',
	PREFERRED_LIGHT_THEME = 'workbench.preferredLightColorTheme',
	PREFERRED_HC_DARK_THEME = 'workbench.preferredHighContrastColorTheme', /* id kept for compatibility reasons */
	PREFERRED_HC_LIGHT_THEME = 'workbench.preferredHighContrastLightColorTheme',
	DETECT_COLOR_SCHEME = 'window.autoDetectColorScheme',
	DETECT_HC = 'window.autoDetectHighContrast',

	SYSTEM_COLOR_THEME = 'window.systemColorTheme'
}

export namespace ThemeSettingDefaults {
	export const COLOR_THEME_DARK = 'Meridian Nocturne';
	export const COLOR_THEME_LIGHT = 'Meridian Porcelain';
	export const COLOR_THEME_HC_DARK = 'Default High Contrast';
	export const COLOR_THEME_HC_LIGHT = 'Default High Contrast Light';

	export const FILE_ICON_THEME = 'vs-seti';
	export const PRODUCT_ICON_THEME = 'Default';
}

/**
 * Migrates legacy theme settings IDs to their current equivalents.
 * Theme IDs were simplified: "Default" prefix was removed from built-in themes,
 * and "Experimental" prefix was replaced when VS Code themes became GA.
 */
export function migrateThemeSettingsId(settingsId: string): string {
	switch (settingsId) {
		case 'Default Dark Modern': return 'Dark Modern';
		case 'Default Light Modern': return 'Light Modern';
		case 'Default Dark+': return 'Dark+';
		case 'Default Light+': return 'Light+';
		case 'Experimental Dark':
		case 'VS Code Dark':
			return ThemeSettingDefaults.COLOR_THEME_DARK;
		case 'Experimental Light':
		case 'VS Code Light':
			return ThemeSettingDefaults.COLOR_THEME_LIGHT;
	}
	return settingsId;
}

export const COLOR_THEME_DARK_INITIAL_COLORS = {
	'actionBar.toggledBackground': '#383a49',
	'activityBar.activeBorder': '#00000000',
	'activityBar.background': '#0A0C13',
	'activityBar.border': '#00000000',
	'activityBar.foreground': '#8F82FF',
	'activityBar.inactiveForeground': '#8189A6',
	'activityBarBadge.background': '#8F82FF',
	'activityBarBadge.foreground': '#0A0C13',
	'badge.background': '#8F82FF29',
	'badge.foreground': '#8F82FF',
	'button.background': '#8F82FF',
	'button.border': '#00000000',
	'button.foreground': '#0A0C13',
	'button.hoverBackground': '#A094FF',
	'button.secondaryBackground': '#00000000',
	'button.secondaryForeground': '#A5ADC4',
	'button.secondaryHoverBackground': '#FFFFFF0D',
	'chat.slashCommandBackground': '#8F82FF29',
	'chat.slashCommandForeground': '#8F82FF',
	'chat.editedFileForeground': '#E2C08D',
	'checkbox.background': '#181C2B',
	'checkbox.border': '#FFFFFF21',
	'debugToolBar.background': '#161923',
	'descriptionForeground': '#8189A6',
	'dropdown.background': '#181C2B',
	'dropdown.border': '#FFFFFF21',
	'dropdown.foreground': '#E7EAF3',
	'dropdown.listBackground': '#161923',
	'editor.background': '#0D101B',
	'editor.findMatchBackground': '#FFB86B66',
	'editor.foreground': '#E7EAF3',
	'editor.inactiveSelectionBackground': '#8F82FF2E',
	'editor.selectionHighlightBackground': '#8F82FF29',
	'editorGroup.border': '#FFFFFF12',
	'editorGroupHeader.tabsBackground': '#11141F',
	'editorGroupHeader.tabsBorder': '#FFFFFF12',
	'editorGutter.addedBackground': '#5FE3C9',
	'editorGutter.deletedBackground': '#FF7B93',
	'editorGutter.modifiedBackground': '#FFB86B',
	'editorIndentGuide.activeBackground1': '#FFFFFF21',
	'editorIndentGuide.background1': '#FFFFFF12',
	'editorLineNumber.activeForeground': '#E7EAF3',
	'editorLineNumber.foreground': '#8189A6CC',
	'editorOverviewRuler.border': '#00000000',
	'editorWidget.background': '#161923',
	'errorForeground': '#FF7B93',
	'focusBorder': '#8F82FFCC',
	'foreground': '#A5ADC4',
	'icon.foreground': '#A5ADC4',
	'input.background': '#181C2B',
	'input.border': '#FFFFFF21',
	'input.foreground': '#E7EAF3',
	'input.placeholderForeground': '#8189A6',
	'inputOption.activeBackground': '#8F82FF29',
	'inputOption.activeBorder': '#8F82FF80',
	'keybindingLabel.foreground': '#A5ADC4',
	'list.activeSelectionIconForeground': '#8F82FF',
	'list.dropBackground': '#8F82FF29',
	'menu.background': '#161923',
	'menu.border': '#FFFFFF21',
	'menu.foreground': '#E7EAF3',
	'menu.selectionBackground': '#8F82FF29',
	'menu.separatorBackground': '#FFFFFF21',
	'notificationCenterHeader.background': '#181C2B',
	'notificationCenterHeader.foreground': '#E7EAF3',
	'notifications.background': '#161923',
	'notifications.border': '#FFFFFF12',
	'notifications.foreground': '#E7EAF3',
	'panel.background': '#11141F',
	'panel.border': '#FFFFFF12',
	'panelInput.border': '#FFFFFF21',
	'panelTitle.activeBorder': '#00000000',
	'panelTitle.activeForeground': '#E7EAF3',
	'panelTitle.inactiveForeground': '#A5ADC4',
	'peekViewEditor.background': '#0D101B',
	'peekViewEditor.matchHighlightBackground': '#FFB86B4D',
	'peekViewResult.background': '#11141F',
	'peekViewResult.matchHighlightBackground': '#FFB86B4D',
	'pickerGroup.border': '#FFFFFF12',
	'ports.iconRunningProcessForeground': '#369432',
	'progressBar.background': '#8F82FF',
	'quickInput.background': '#161923',
	'quickInput.foreground': '#E7EAF3',
	'settings.dropdownBackground': '#313131',
	'settings.dropdownBorder': '#3C3C3C',
	'settings.headerForeground': '#E7EAF3',
	'settings.modifiedItemIndicator': '#8F82FF',
	'sideBar.background': '#11141F',
	'sideBar.border': '#00000000',
	'sideBar.foreground': '#A5ADC4',
	'sideBarSectionHeader.background': '#11141F',
	'sideBarSectionHeader.border': '#FFFFFF12',
	'sideBarSectionHeader.foreground': '#8189A6',
	'sideBarTitle.foreground': '#E7EAF3',
	'statusBar.background': '#0A0C13',
	'statusBar.border': '#00000000',
	'statusBar.debuggingBackground': '#8F82FF29',
	'statusBar.debuggingForeground': '#8F82FF',
	'statusBar.focusBorder': '#8F82FFCC',
	'statusBar.foreground': '#A5ADC4',
	'statusBar.noFolderBackground': '#0A0C13',
	'statusBarItem.focusBorder': '#8F82FFCC',
	'statusBarItem.prominentBackground': '#8F82FF29',
	'statusBarItem.remoteBackground': '#8F82FF29',
	'statusBarItem.remoteForeground': '#8F82FF',
	'tab.activeBackground': '#0D101B',
	'tab.activeBorder': '#00000000',
	'tab.activeBorderTop': '#00000000',
	'tab.activeForeground': '#E7EAF3',
	'tab.border': '#00000000',
	'tab.hoverBackground': '#FFFFFF0D',
	'tab.inactiveBackground': '#00000000',
	'tab.inactiveForeground': '#A5ADC4',
	'tab.lastPinnedBorder': '#FFFFFF21',
	'tab.selectedBackground': '#0D101B',
	'tab.selectedBorderTop': '#6caddf',
	'tab.selectedForeground': '#E7EAF3',
	'tab.unfocusedActiveBorder': '#1F1F1F',
	'tab.unfocusedActiveBorderTop': '#00000000',
	'tab.unfocusedHoverBackground': '#1F1F1F',
	'terminal.foreground': '#E7EAF3',
	'terminal.inactiveSelectionBackground': '#3A3D41',
	'terminal.tab.activeBorder': '#8F82FF',
	'textBlockQuote.background': '#181C2B',
	'textBlockQuote.border': '#FFFFFF21',
	'textCodeBlock.background': '#181C2B',
	'textLink.activeForeground': '#A094FF',
	'textLink.foreground': '#8F82FF',
	'textPreformat.background': '#181C2B',
	'textPreformat.foreground': '#E7EAF3',
	'textSeparator.foreground': '#FFFFFF21',
	'titleBar.activeBackground': '#0A0C13',
	'titleBar.activeForeground': '#A5ADC4',
	'titleBar.border': '#00000000',
	'titleBar.inactiveBackground': '#0A0C13',
	'titleBar.inactiveForeground': '#8189A6',
	'welcomePage.progress.foreground': '#0078D4',
	'welcomePage.tileBackground': '#11141F',
	'widget.border': '#313131'
};

export const COLOR_THEME_LIGHT_INITIAL_COLORS = {
	'actionBar.toggledBackground': '#dddddd',
	'activityBar.activeBorder': '#00000000',
	'activityBar.background': '#E6E2DC',
	'activityBar.border': '#00000000',
	'activityBar.foreground': '#4A3FD6',
	'activityBar.inactiveForeground': '#68657A',
	'activityBarBadge.background': '#4A3FD6',
	'activityBarBadge.foreground': '#FFFFFF',
	'badge.background': '#4A3FD61A',
	'badge.foreground': '#4A3FD6',
	'button.background': '#4A3FD6',
	'button.border': '#00000000',
	'button.foreground': '#FFFFFF',
	'button.hoverBackground': '#3F35C2',
	'button.secondaryBackground': '#00000000',
	'button.secondaryForeground': '#4B4958',
	'button.secondaryHoverBackground': '#1E18100D',
	'chat.slashCommandBackground': '#4A3FD61A',
	'chat.slashCommandForeground': '#4A3FD6',
	'chat.editedFileForeground': '#895503',
	'checkbox.background': '#FFFFFF',
	'checkbox.border': '#1E18102E',
	'descriptionForeground': '#68657A',
	'diffEditor.unchangedRegionBackground': '#f8f8f8',
	'dropdown.background': '#FFFFFF',
	'dropdown.border': '#1E18102E',
	'dropdown.foreground': '#1C1A22',
	'dropdown.listBackground': '#FFFFFF',
	'editor.background': '#FDFCFA',
	'editor.foreground': '#1C1A22',
	'editor.inactiveSelectionBackground': '#4A3FD61F',
	'editor.selectionHighlightBackground': '#4A3FD61A',
	'editorGroup.border': '#1E18101A',
	'editorGroupHeader.tabsBackground': '#F5F2ED',
	'editorGroupHeader.tabsBorder': '#1E18101A',
	'editorGutter.addedBackground': '#0B7A68',
	'editorGutter.deletedBackground': '#B3243B',
	'editorGutter.modifiedBackground': '#9E4410',
	'editorIndentGuide.activeBackground1': '#1E18102E',
	'editorIndentGuide.background1': '#1E18101A',
	'editorLineNumber.activeForeground': '#1C1A22',
	'editorLineNumber.foreground': '#68657ACC',
	'editorOverviewRuler.border': '#00000000',
	'editorSuggestWidget.background': '#FFFFFF',
	'editorWidget.background': '#FFFFFF',
	'errorForeground': '#B3243B',
	'focusBorder': '#4A3FD6CC',
	'foreground': '#4B4958',
	'icon.foreground': '#4B4958',
	'input.background': '#FFFFFF',
	'input.border': '#1E18102E',
	'input.foreground': '#1C1A22',
	'input.placeholderForeground': '#68657A',
	'inputOption.activeBackground': '#4A3FD61A',
	'inputOption.activeBorder': '#4A3FD680',
	'inputOption.activeForeground': '#1C1A22',
	'keybindingLabel.foreground': '#4B4958',
	'list.activeSelectionBackground': '#4A3FD61A',
	'list.activeSelectionForeground': '#1C1A22',
	'list.activeSelectionIconForeground': '#4A3FD6',
	'list.focusAndSelectionOutline': '#005FB8',
	'list.hoverBackground': '#1E18100D',
	'menu.border': '#1E18102E',
	'menu.selectionBackground': '#4A3FD61A',
	'menu.selectionForeground': '#1C1A22',
	'notebook.cellBorderColor': '#E5E5E5',
	'notebook.selectedCellBackground': '#C8DDF150',
	'notificationCenterHeader.background': '#FFFFFF',
	'notificationCenterHeader.foreground': '#1C1A22',
	'notifications.background': '#FFFFFF',
	'notifications.border': '#1E18101A',
	'notifications.foreground': '#1C1A22',
	'panel.background': '#F5F2ED',
	'panel.border': '#1E18101A',
	'panelInput.border': '#1E18102E',
	'panelTitle.activeBorder': '#00000000',
	'panelTitle.activeForeground': '#1C1A22',
	'panelTitle.inactiveForeground': '#4B4958',
	'peekViewEditor.matchHighlightBackground': '#9E44104D',
	'peekViewResult.background': '#F5F2ED',
	'peekViewResult.matchHighlightBackground': '#9E44104D',
	'pickerGroup.border': '#1E18101A',
	'pickerGroup.foreground': '#68657A',
	'ports.iconRunningProcessForeground': '#369432',
	'progressBar.background': '#4A3FD6',
	'quickInput.background': '#FFFFFF',
	'quickInput.foreground': '#1C1A22',
	'searchEditor.textInputBorder': '#CECECE',
	'settings.dropdownBackground': '#FFFFFF',
	'settings.dropdownBorder': '#CECECE',
	'settings.headerForeground': '#1C1A22',
	'settings.modifiedItemIndicator': '#4A3FD6',
	'settings.numberInputBorder': '#CECECE',
	'settings.textInputBorder': '#CECECE',
	'sideBar.background': '#F5F2ED',
	'sideBar.border': '#00000000',
	'sideBar.foreground': '#4B4958',
	'sideBarSectionHeader.background': '#F5F2ED',
	'sideBarSectionHeader.border': '#1E18101A',
	'sideBarSectionHeader.foreground': '#68657A',
	'sideBarTitle.foreground': '#1C1A22',
	'statusBar.background': '#E6E2DC',
	'statusBar.border': '#00000000',
	'statusBar.debuggingBackground': '#4A3FD61A',
	'statusBar.debuggingForeground': '#4A3FD6',
	'statusBar.focusBorder': '#4A3FD6CC',
	'statusBar.foreground': '#4B4958',
	'statusBar.noFolderBackground': '#E6E2DC',
	'statusBarItem.compactHoverBackground': '#1E18100D',
	'statusBarItem.errorBackground': '#00000000',
	'statusBarItem.focusBorder': '#4A3FD6CC',
	'statusBarItem.hoverBackground': '#1E18100D',
	'statusBarItem.prominentBackground': '#4A3FD61A',
	'statusBarItem.remoteBackground': '#4A3FD61A',
	'statusBarItem.remoteForeground': '#4A3FD6',
	'tab.activeBackground': '#FDFCFA',
	'tab.activeBorder': '#00000000',
	'tab.activeBorderTop': '#00000000',
	'tab.activeForeground': '#1C1A22',
	'tab.border': '#00000000',
	'tab.hoverBackground': '#1E18100D',
	'tab.inactiveBackground': '#00000000',
	'tab.inactiveForeground': '#4B4958',
	'tab.lastPinnedBorder': '#1E18102E',
	'tab.selectedBackground': '#FDFCFA',
	'tab.selectedBorderTop': '#68a3da',
	'tab.selectedForeground': '#1C1A22',
	'tab.unfocusedActiveBorder': '#F8F8F8',
	'tab.unfocusedActiveBorderTop': '#00000000',
	'tab.unfocusedHoverBackground': '#F8F8F8',
	'terminal.foreground': '#1C1A22',
	'terminal.inactiveSelectionBackground': '#E5EBF1',
	'terminal.tab.activeBorder': '#4A3FD6',
	'terminalCursor.foreground': '#4B4958',
	'textBlockQuote.background': '#FFFFFF',
	'textBlockQuote.border': '#1E18102E',
	'textCodeBlock.background': '#FFFFFF',
	'textLink.activeForeground': '#3F35C2',
	'textLink.foreground': '#4A3FD6',
	'textPreformat.background': '#FFFFFF',
	'textPreformat.foreground': '#1C1A22',
	'textSeparator.foreground': '#1E18102E',
	'titleBar.activeBackground': '#E6E2DC',
	'titleBar.activeForeground': '#4B4958',
	'titleBar.border': '#00000000',
	'titleBar.inactiveBackground': '#E6E2DC',
	'titleBar.inactiveForeground': '#68657A',
	'welcomePage.tileBackground': '#F5F2ED',
	'widget.border': '#E5E5E5'
};

export interface IWorkbenchTheme {
	readonly id: string;
	readonly label: string;
	readonly extensionData?: ExtensionData;
	readonly description?: string;
	readonly settingsId: string | null;
}

export interface IWorkbenchColorTheme extends IWorkbenchTheme, IColorTheme {
	readonly settingsId: string;
	readonly tokenColors: ITextMateThemingRule[];
}

export interface IColorMap {
	[id: string]: Color;
}

export interface IWorkbenchFileIconTheme extends IWorkbenchTheme, IFileIconTheme {
}

export interface IWorkbenchProductIconTheme extends IWorkbenchTheme, IProductIconTheme {
	readonly settingsId: string;

	getIcon(icon: IconContribution): IconDefinition | undefined;
}

export type ThemeSettingTarget = ConfigurationTarget | undefined | 'auto' | 'preview';


export interface IWorkbenchThemeService extends IThemeService {
	readonly _serviceBrand: undefined;
	setColorTheme(themeId: string | undefined | IWorkbenchColorTheme, settingsTarget: ThemeSettingTarget): Promise<IWorkbenchColorTheme | null>;
	getColorTheme(): IWorkbenchColorTheme;
	/** Returns the selected theme and user customizations without window-local overlays. */
	getBaseColorTheme(): IWorkbenchColorTheme;
	getColorThemes(): Promise<IWorkbenchColorTheme[]>;
	getMarketplaceColorThemes(publisher: string, name: string, version: string): Promise<IWorkbenchColorTheme[]>;
	readonly onDidColorThemeChange: Event<IWorkbenchColorTheme>;

	/** Applies window-local colors computed from the base theme, without persisting them or changing the selected theme. */
	registerColorThemeOverlay(getColors: (theme: IWorkbenchColorTheme) => IColorMap): IDisposable;

	getPreferredColorScheme(): ColorScheme | undefined;

	setFileIconTheme(iconThemeId: string | undefined | IWorkbenchFileIconTheme, settingsTarget: ThemeSettingTarget): Promise<IWorkbenchFileIconTheme>;
	getFileIconTheme(): IWorkbenchFileIconTheme;
	getFileIconThemes(): Promise<IWorkbenchFileIconTheme[]>;
	getMarketplaceFileIconThemes(publisher: string, name: string, version: string): Promise<IWorkbenchFileIconTheme[]>;
	readonly onDidFileIconThemeChange: Event<IWorkbenchFileIconTheme>;

	setProductIconTheme(iconThemeId: string | undefined | IWorkbenchProductIconTheme, settingsTarget: ThemeSettingTarget): Promise<IWorkbenchProductIconTheme>;
	getProductIconTheme(): IWorkbenchProductIconTheme;
	getProductIconThemes(): Promise<IWorkbenchProductIconTheme[]>;
	getMarketplaceProductIconThemes(publisher: string, name: string, version: string): Promise<IWorkbenchProductIconTheme[]>;
	readonly onDidProductIconThemeChange: Event<IWorkbenchProductIconTheme>;
}

export interface IThemeScopedColorCustomizations {
	[colorId: string]: string;
}

export interface IColorCustomizations {
	[colorIdOrThemeScope: string]: IThemeScopedColorCustomizations | string;
}

export interface IThemeScopedTokenColorCustomizations {
	[groupId: string]: ITextMateThemingRule[] | ITokenColorizationSetting | boolean | string | undefined;
	comments?: string | ITokenColorizationSetting;
	strings?: string | ITokenColorizationSetting;
	numbers?: string | ITokenColorizationSetting;
	keywords?: string | ITokenColorizationSetting;
	types?: string | ITokenColorizationSetting;
	functions?: string | ITokenColorizationSetting;
	variables?: string | ITokenColorizationSetting;
	textMateRules?: ITextMateThemingRule[];
	semanticHighlighting?: boolean; // deprecated, use ISemanticTokenColorCustomizations.enabled instead
}

export interface ITokenColorCustomizations {
	[groupIdOrThemeScope: string]: IThemeScopedTokenColorCustomizations | ITextMateThemingRule[] | ITokenColorizationSetting | boolean | string | undefined;
	comments?: string | ITokenColorizationSetting;
	strings?: string | ITokenColorizationSetting;
	numbers?: string | ITokenColorizationSetting;
	keywords?: string | ITokenColorizationSetting;
	types?: string | ITokenColorizationSetting;
	functions?: string | ITokenColorizationSetting;
	variables?: string | ITokenColorizationSetting;
	textMateRules?: ITextMateThemingRule[];
	semanticHighlighting?: boolean; // deprecated, use ISemanticTokenColorCustomizations.enabled instead
}

export interface IThemeScopedSemanticTokenColorCustomizations {
	[styleRule: string]: ISemanticTokenRules | boolean | undefined;
	enabled?: boolean;
	rules?: ISemanticTokenRules;
}

export interface ISemanticTokenColorCustomizations {
	[styleRuleOrThemeScope: string]: IThemeScopedSemanticTokenColorCustomizations | ISemanticTokenRules | boolean | undefined;
	enabled?: boolean;
	rules?: ISemanticTokenRules;
}

export interface IThemeScopedExperimentalSemanticTokenColorCustomizations {
	[themeScope: string]: ISemanticTokenRules | undefined;
}

export interface IExperimentalSemanticTokenColorCustomizations {
	[styleRuleOrThemeScope: string]: IThemeScopedExperimentalSemanticTokenColorCustomizations | ISemanticTokenRules | undefined;
}

export type IThemeScopedCustomizations =
	IThemeScopedColorCustomizations
	| IThemeScopedTokenColorCustomizations
	| IThemeScopedExperimentalSemanticTokenColorCustomizations
	| IThemeScopedSemanticTokenColorCustomizations;

export type IThemeScopableCustomizations =
	IColorCustomizations
	| ITokenColorCustomizations
	| IExperimentalSemanticTokenColorCustomizations
	| ISemanticTokenColorCustomizations;

export interface ISemanticTokenRules {
	[selector: string]: string | ISemanticTokenColorizationSetting | undefined;
}

export interface ITextMateThemingRule {
	name?: string;
	scope?: string | string[];
	settings: ITokenColorizationSetting;
}

export interface ITokenColorizationSetting {
	foreground?: string;
	background?: string;
	fontStyle?: string; /* [italic|bold|underline|strikethrough] */
	fontFamily?: string;
	fontSize?: number;
	lineHeight?: number;
}

export interface ISemanticTokenColorizationSetting {
	foreground?: string;
	fontStyle?: string; /* [italic|bold|underline|strikethrough] */
	bold?: boolean;
	underline?: boolean;
	strikethrough?: boolean;
	italic?: boolean;
}

export interface ExtensionData {
	extensionId: string;
	extensionPublisher: string;
	extensionName: string;
	extensionIsBuiltin: boolean;
}

export namespace ExtensionData {
	export function toJSONObject(d: ExtensionData | undefined): any {
		return d && { _extensionId: d.extensionId, _extensionIsBuiltin: d.extensionIsBuiltin, _extensionName: d.extensionName, _extensionPublisher: d.extensionPublisher };
	}
	export function fromJSONObject(o: any): ExtensionData | undefined {
		if (o && isString(o._extensionId) && isBoolean(o._extensionIsBuiltin) && isString(o._extensionName) && isString(o._extensionPublisher)) {
			return { extensionId: o._extensionId, extensionIsBuiltin: o._extensionIsBuiltin, extensionName: o._extensionName, extensionPublisher: o._extensionPublisher };
		}
		return undefined;
	}
	export function fromName(publisher: string, name: string, isBuiltin = false): ExtensionData {
		return { extensionPublisher: publisher, extensionId: `${publisher}.${name}`, extensionName: name, extensionIsBuiltin: isBuiltin };
	}
}

export interface IThemeExtensionPoint {
	id: string;
	label?: string;
	description?: string;
	path: string;
	uiTheme?: ThemeTypeSelector;
	_watch: boolean; // unsupported options to watch location
}
