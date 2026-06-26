"""Live tests for organizations + read-only webhook/telegram/ngrok tools.

Activation paths (register_webhooks, register_telegram_trigger, ngrok update,
webhook-trigger create/update/delete) are DEFERRED — they need a bot token +
ngrok/public URL not provisioned in this pass — so only the read/introspection
tools are exercised here.
"""
from __future__ import annotations

import pytest

from epicstaff_mcp.exceptions import EpicStaffAPIError
from epicstaff_mcp.tools import flows, organizations as orgs, webhooks


# ------------------------------------------------------------- organizations

async def test_org_admin_is_superadmin_gated():
    """Org CRUD lives behind OrganizationAdminViewSet (IsSuperadmin). With a
    non-superadmin key the whole surface returns 404 — wiring is correct, but it
    can't be exercised here. This documents the gate."""
    with pytest.raises(EpicStaffAPIError):
        await orgs.list_organizations()


async def test_graph_organization_association():
    """GraphOrganization tools (not superadmin-gated) — remove the auto-created
    default-org association, then re-add it (exercises list/remove/add)."""
    flow = await flows.create_flow(name="Audit GraphOrg Flow")
    fid = flow["id"]
    try:
        # a new flow is auto-associated with the default org
        listed = await orgs.list_graph_organizations(flow_id=fid)
        assert listed["count"] >= 1
        assoc = listed["results"][0]
        assoc_id, org_id = assoc["id"], assoc["organization"]

        await orgs.remove_graph_organization(assoc_id)
        readded = await orgs.add_graph_organization(fid, org_id)
        assert readded.get("id") is not None

        gou = await orgs.list_graph_organization_users(org_id=org_id)
        assert isinstance(gou, dict)
    finally:
        await flows.delete_flow(fid)


async def test_org_user_list_works():
    """Org-user tools were mis-pathed to an unregistered /api/organization-users/;
    re-pathed to /api/admin/organizations/{org_id}/users/. Verify it now lists."""
    result = await orgs.list_organization_users(org_id=2)
    members = result.get("results", result if isinstance(result, list) else [])
    assert isinstance(members, list)


# --------------------------------------------- deferred families (read-only)

async def test_webhook_reads():
    triggers = await webhooks.list_webhook_triggers()
    assert isinstance(triggers, dict)
    nodes = await webhooks.list_webhook_trigger_nodes()
    assert isinstance(nodes, dict)
    if triggers.get("results"):
        tid = triggers["results"][0]["id"]
        single = await webhooks.get_webhook_trigger(tid)
        assert single["id"] == tid


async def test_telegram_reads():
    nodes = await webhooks.list_telegram_trigger_nodes()
    assert isinstance(nodes, dict)
    fields = await webhooks.list_telegram_trigger_node_fields()
    assert isinstance(fields, dict)
    available = await webhooks.list_telegram_available_fields()
    assert isinstance(available, dict)
    if nodes.get("results"):
        nid = nodes["results"][0]["id"]
        single = await webhooks.get_telegram_trigger_node(nid)
        assert single["id"] == nid


async def test_ngrok_config_read():
    cfg = await webhooks.get_ngrok_config()
    assert isinstance(cfg, dict)
