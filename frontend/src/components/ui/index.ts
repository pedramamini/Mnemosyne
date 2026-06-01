/**
 * Barrel export for the canonical shared component library.
 *
 * Feature code imports UI exclusively from `@/components/ui` - never raw
 * interactive HTML and never one-off styled controls. See README.md for the
 * full reuse contract (it is lint-enforced). A missing primitive is ADDED here
 * (with a catalog entry) and consumed from here, never built locally.
 */

export type { AppShellProps } from "./AppShell";
/* Application shell */
export { AppShell, useAppShell } from "./AppShell";
export type { AvatarProps } from "./Avatar";
export { Avatar, initialsOf } from "./Avatar";
export type { BackButtonProps } from "./BackButton";
export { BackButton } from "./BackButton";
export type { BadgeProps, BadgeVariant, TagProps } from "./Badge";
/* Status + data display */
export { Badge, Tag } from "./Badge";
export type { AlertProps, BannerProps, BannerVariant } from "./Banner";
export { Alert, Banner } from "./Banner";
export type { BoxProps } from "./Box";
/* Layout primitives */
export { Box } from "./Box";
export type { ButtonProps, ButtonSize, ButtonVariant } from "./Button";
/* Actions + icons */
export { Button } from "./Button";
export type { CheckboxProps } from "./Checkbox";
export { Checkbox } from "./Checkbox";
export type { CodeProps, KbdProps } from "./Code";
export { Code, Kbd } from "./Code";
export type { CommandItem, CommandPaletteProps } from "./CommandPalette";
export { CommandPalette } from "./CommandPalette";
export type { ContainerProps } from "./Container";
export { Container, Page } from "./Container";
export type { DividerProps } from "./Divider";
export { Divider } from "./Divider";
export type { DrawerProps } from "./Drawer";
export { Drawer } from "./Drawer";
export type { EmptyStateProps } from "./EmptyState";
export { EmptyState } from "./EmptyState";
export type { FileButtonProps } from "./FileButton";
export { FileButton } from "./FileButton";
export type { FormFieldProps } from "./FormField";
/* Form controls */
export { FormField, useFormField } from "./FormField";
export type { GridProps } from "./Grid";
export { Grid } from "./Grid";
export type { HeadingProps } from "./Heading";
export { Heading } from "./Heading";
export type { IconProps } from "./Icon";
export { Icon } from "./Icon";
export type { IconButtonProps } from "./IconButton";
export { IconButton } from "./IconButton";
export type { InlineProps } from "./Inline";
export { Inline } from "./Inline";
export type { InputProps } from "./Input";
export { Input } from "./Input";
export type { LinkButtonProps } from "./LinkButton";
export { LinkButton } from "./LinkButton";
export type { ListItemProps, ListProps } from "./List";
export { List, ListItem } from "./List";
export type { MenuItemSpec, MenuProps } from "./Menu";
export { Dropdown, Menu } from "./Menu";
export type { DialogProps, ModalProps } from "./Modal";
/* Overlays + feedback */
export { Dialog, Modal } from "./Modal";
export type { NavItemProps } from "./NavItem";
export { NavItem } from "./NavItem";
export type { PaginationProps } from "./Pagination";
export { Pagination } from "./Pagination";
export type { CardProps, PanelProps } from "./Panel";
export { Card, Panel } from "./Panel";
export type { PortalProps } from "./Portal";
export { Portal } from "./Portal";
export type { ProgressBarProps } from "./ProgressBar";
export { ProgressBar } from "./ProgressBar";
export type { RadioProps } from "./Radio";
export { Radio } from "./Radio";
export type { RoutedTabSpec, RoutedTabsProps } from "./RoutedTabs";
export { RoutedTabs } from "./RoutedTabs";
export type { SearchInputProps } from "./SearchInput";
export { SearchInput } from "./SearchInput";
export type { SelectOption, SelectProps } from "./Select";
export { Select } from "./Select";
export type { SettingRowProps } from "./SettingRow";
export { SettingRow } from "./SettingRow";
export type { SidebarProps } from "./Sidebar";
export { Sidebar } from "./Sidebar";
export type { SkeletonProps } from "./Skeleton";
export { Skeleton } from "./Skeleton";
export type { SpinnerProps } from "./Spinner";
export { Spinner } from "./Spinner";
export type { StackProps } from "./Stack";
export { Stack } from "./Stack";
export type { SwitchProps } from "./Switch";
export { Switch } from "./Switch";
export type { TableColumn, TableProps } from "./Table";
export {
  Table,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "./Table";
export type { TabSpec, TabsProps } from "./Tabs";
export { Tabs } from "./Tabs";
export type { TextProps } from "./Text";
/* Typography */
export { Text } from "./Text";
export type { TextareaProps } from "./Textarea";
export { Textarea } from "./Textarea";
export type { ToastOptions, ToastProviderProps, ToastVariant } from "./Toast";
export { ToastProvider, useToast } from "./Toast";
export type { TooltipProps } from "./Tooltip";
export { Tooltip } from "./Tooltip";
export type { TopBarProps } from "./TopBar";
export { TopBar } from "./TopBar";
