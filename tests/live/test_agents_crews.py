"""Live tests for agents, tasks, and crews.

Covers epicstaff_mcp/tools/agents.py, tasks.py, crews.py.
"""
from __future__ import annotations

import pytest

from epicstaff_mcp.tools import agents, crews, knowledge, tasks


# --------------------------------------------------------------------- agents

async def test_agent_lifecycle(llm_config_id):
    created = await agents.create_agent(
        role="Audit Probe Agent",
        goal="verify the create path",
        backstory="a disposable agent",
        llm_config=llm_config_id,
        max_iter=5,
    )
    agent_id = created["id"]
    copy_id = None
    try:
        fetched = await agents.get_agent(agent_id)
        assert fetched["id"] == agent_id

        updated = await agents.update_agent(agent_id, goal="updated goal")
        assert updated["goal"] == "updated goal"

        listed = await agents.list_agents(search="Audit Probe")
        assert any(a["id"] == agent_id for a in listed["results"])

        copy = await agents.copy_agent(agent_id)
        copy_id = copy.get("id")
        assert copy_id and copy_id != agent_id
    finally:
        if copy_id:
            await agents.delete_agent(copy_id)
        msg = await agents.delete_agent(agent_id)
        assert "deleted" in msg["message"]


async def test_agent_knowledge_binding(llm_config_id, embedding_config_id):
    coll = await knowledge.create_source_collection(
        "audit-agent-kb", embedding_config=embedding_config_id
    )
    cid = coll["collection_id"]
    agent_id = None
    try:
        await knowledge.add_document(cid, content="binding probe content")
        rag = await knowledge.create_naive_rag(collection_id=cid, embedder_id=embedding_config_id)
        rag_id = rag["naive_rag"]["naive_rag_id"]

        created = await agents.create_agent(
            role="KB Agent",
            goal="retrieve",
            backstory="bound to a collection",
            llm_config=llm_config_id,
            knowledge_collection=cid,
            naive_rag_id=rag_id,
        )
        agent_id = created["id"]
        # the binding must round-trip — agent is linked to the collection
        assert created.get("knowledge_collection") == cid
    finally:
        if agent_id:
            await agents.delete_agent(agent_id)
        await knowledge.delete_source_collection(cid)


async def test_agent_tags():
    created = await agents.create_agent_tag(name="audit-agent-tag")
    tag_id = created["id"]
    try:
        listed = await agents.list_agent_tags()
        assert any(t["id"] == tag_id for t in listed["results"])
    finally:
        msg = await agents.delete_agent_tag(tag_id)
        assert "deleted" in msg["message"]


async def test_template_agents():
    listed = await agents.list_template_agents()
    assert isinstance(listed, dict)
    if listed.get("results"):
        tid = listed["results"][0]["id"]
        single = await agents.get_template_agent(tid)
        assert single["id"] == tid


# ---------------------------------------------------------------------- crews

async def test_crew_lifecycle(llm_config_id):
    agent = await agents.create_agent(
        role="Crew Member", goal="work", backstory="member", llm_config=llm_config_id
    )
    agent_id = agent["id"]
    copy_id = None
    crew_id = None
    try:
        created = await crews.create_crew(
            name="Audit Probe Crew", description="probe", agents=[agent_id]
        )
        crew_id = created["id"]

        fetched = await crews.get_crew(crew_id)
        assert fetched["id"] == crew_id

        updated = await crews.update_crew(crew_id, description="probe v2")
        assert updated["description"] == "probe v2"

        listed = await crews.list_crews()
        assert any(c["id"] == crew_id for c in listed["results"])

        copy = await crews.copy_crew(crew_id)
        copy_id = copy.get("id")
        assert copy_id and copy_id != crew_id
    finally:
        if copy_id:
            await crews.delete_crew(copy_id)
        if crew_id:
            await crews.delete_crew(crew_id)
        await agents.delete_agent(agent_id)


async def test_crew_tags():
    created = await crews.create_crew_tag(name="audit-crew-tag")
    tag_id = created["id"]
    try:
        listed = await crews.list_crew_tags()
        assert any(t["id"] == tag_id for t in listed["results"])
    finally:
        msg = await crews.delete_crew_tag(tag_id)
        assert "deleted" in msg["message"]


# ---------------------------------------------------------------------- tasks

async def test_task_lifecycle(llm_config_id):
    agent = await agents.create_agent(
        role="Task Agent", goal="do task", backstory="t", llm_config=llm_config_id
    )
    agent_id = agent["id"]
    crew = await crews.create_crew(name="Audit Task Crew", agents=[agent_id])
    crew_id = crew["id"]
    task_id = None
    try:
        created = await tasks.create_task(
            name="audit-probe-task",
            instructions="say hello",
            expected_output="a greeting",
            crew=crew_id,
            agent=agent_id,
            order=1,
        )
        task_id = created["id"]

        fetched = await tasks.get_task(task_id)
        assert fetched["id"] == task_id

        updated = await tasks.update_task(task_id, expected_output="a polite greeting")
        assert updated["expected_output"] == "a polite greeting"

        listed = await tasks.list_tasks(crew=crew_id)
        assert any(t["id"] == task_id for t in listed["results"])
    finally:
        if task_id:
            msg = await tasks.delete_task(task_id)
            assert "deleted" in msg["message"]
        await crews.delete_crew(crew_id)
        await agents.delete_agent(agent_id)
