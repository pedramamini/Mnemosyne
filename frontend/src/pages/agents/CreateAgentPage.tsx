import { useNavigate } from "react-router-dom";
import { CreateAgentWizard } from "@/components/agents/CreateAgentWizard";
import { AppLayout } from "@/components/layout/AppLayout";
import { BackButton, Page, Stack } from "@/components/ui";

/**
 * CreateAgentPage (MNEMO-34, mounted at `/agents/new`) - hosts the create wizard
 * inside the app shell. On `onCreated` it routes to the new agent's detail page
 * (MNEMO-36); a "Cancel" affordance (right-aligned to the content edge, mirroring
 * the flow's trailing primary action) returns to the agent list.
 */
export function CreateAgentPage() {
  const navigate = useNavigate();

  const cancel = (
    <BackButton align="end" size="md" onClick={() => navigate("/agents")}>
      Cancel
    </BackButton>
  );

  return (
    <AppLayout>
      <Page style={{ paddingBlock: "var(--space-6)" }}>
        <Stack gap="5">
          {cancel}
          <CreateAgentWizard
            onCreated={(agentId) => navigate(`/agents/${agentId}`)}
          />
        </Stack>
      </Page>
    </AppLayout>
  );
}
