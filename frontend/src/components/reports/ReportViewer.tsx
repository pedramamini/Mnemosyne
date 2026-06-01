import type { Report } from "@/api/reports";
import {
  BackButton,
  EmptyState,
  Panel,
  Skeleton,
  Stack,
} from "@/components/ui";
import { FrontMatterHeader } from "./FrontMatterHeader";
import { MarkdownRenderer } from "./MarkdownRenderer";

export interface ReportViewerProps {
  /** The report to show, or null when none is selected. */
  report: Report | null;
  /** True while the selected report is loading. */
  isLoading?: boolean;
  /** Back/close affordance - when set, renders a "Back" control. */
  onClose?: () => void;
}

/** Loading skeleton: a faux header + a few body lines. */
function LoadingSkeleton() {
  return (
    <Stack gap="4" aria-busy="true" aria-label="Loading report">
      <Stack gap="2">
        <Skeleton width="60%" height="1.75rem" />
        <Skeleton width="8rem" height="0.875rem" />
      </Stack>
      <Stack gap="2">
        <Skeleton width="100%" height="1rem" />
        <Skeleton width="95%" height="1rem" />
        <Skeleton width="88%" height="1rem" />
        <Skeleton width="92%" height="1rem" />
      </Stack>
    </Stack>
  );
}

/**
 * ReportViewer (MNEMO-41) - the single-report pane composing `FrontMatterHeader`
 * + `MarkdownRenderer`. Shows a loading skeleton while fetching, an empty prompt
 * when nothing is selected, then the front-matter header and the rendered body
 * with embedded PNG charts resolved via the report's `assets`. An optional
 * `onClose` renders a "Back" affordance. Presentational only.
 */
export function ReportViewer({
  report,
  isLoading,
  onClose,
}: ReportViewerProps) {
  return (
    <Panel padding="4">
      <Stack gap="4">
        {onClose && <BackButton onClick={onClose}>Back</BackButton>}

        {isLoading ? (
          <LoadingSkeleton />
        ) : report ? (
          <Stack gap="4">
            <FrontMatterHeader
              frontMatter={report.frontMatter}
              title={report.title}
              createdAt={report.createdAt}
            />
            <MarkdownRenderer
              markdown={report.markdown}
              assets={report.assets}
            />
          </Stack>
        ) : (
          <EmptyState
            title="Select a report"
            description="Choose a report from the list to read it here."
          />
        )}
      </Stack>
    </Panel>
  );
}
