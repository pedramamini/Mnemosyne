import { Download } from "lucide-react";
import { brainArchiveUrl } from "@/api/brain";
import { Icon, LinkButton, Tooltip } from "@/components/ui";

export interface DownloadBrainButtonProps {
  agentId: string;
}

/**
 * DownloadBrainButton (MNEMO-38, PRD §6.9) - links to the whole-brain archive.
 * It's a real anchor (`LinkButton` + `download`), so the browser follows the
 * MNEMO-11 archive endpoint with the auth cookie and streams the `.zip` itself;
 * nothing is fetched through the SPA.
 */
export function DownloadBrainButton({ agentId }: DownloadBrainButtonProps) {
  return (
    <Tooltip content="Download the entire brain as an archive (PRD §6.9)">
      <LinkButton
        href={brainArchiveUrl(agentId)}
        download
        variant="secondary"
        size="sm"
        leftIcon={<Icon icon={Download} size="sm" />}
      >
        Download brain (.zip)
      </LinkButton>
    </Tooltip>
  );
}
