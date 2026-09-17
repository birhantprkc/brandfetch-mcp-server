"""The initialize handshake publishes `mcp.client.connected` with the client's identity."""

import asyncio

import pytest
from fastmcp import Client

from src import main
from src.utils import events


@pytest.fixture
def published(monkeypatch):
    calls = []
    monkeypatch.setattr(
        events, "publish", lambda name, urn, payload: calls.append((name, urn, payload))
    )
    return calls


@pytest.fixture
def credentials():
    """A session whose bearer token carried an organization, as the dashboard mints it.

    The context vars are set the way `CredentialsMiddleware` sets them: a task copies the
    context it is created in, so `asyncio.run` below sees these.
    """
    org_urn = "urn:brandfetch:organization:org-1"
    org_token = main._org_urn_var.set(org_urn)
    client_token = main._client_id_var.set("1abcdefghijklmnopq")
    yield org_urn
    main._org_urn_var.reset(org_token)
    main._client_id_var.reset(client_token)


def connect(client_name: str = "claude-ai", client_version: str = "1.2.3"):
    """Run a real initialize handshake against the in-memory server."""

    async def run():
        async with Client(main.mcp, client_info={"name": client_name, "version": client_version}):
            pass

    asyncio.run(run())


def test_initialize_publishes_the_connection(published, credentials):
    connect()

    assert len(published) == 1
    name, urn, payload = published[0]
    assert name == "mcp.client.connected"
    assert urn == credentials
    assert payload["client"] == {"name": "claude-ai", "version": "1.2.3"}
    assert payload["protocolVersion"]
    assert payload["session"]["actor"] == {"type": "organization", "urn": credentials}


def test_connection_carries_the_client_that_connected(published, credentials):
    connect(client_name="cursor", client_version="0.9")

    assert published[0][2]["client"] == {"name": "cursor", "version": "0.9"}


# Credential-less sessions reach the keyless tools, so they reach initialize too; they are
# published against the anonymous actor and the consumer decides what to do with them.
def test_initialize_without_credentials_still_publishes(published):
    connect()

    assert len(published) == 1
    assert published[0][1] == "urn:brandfetch:api-key:anonymous"


def test_tool_calls_are_not_client_events(published, credentials):
    """`mcp.client.*` is the connection namespace; nothing else publishes into it."""

    async def run():
        async with Client(main.mcp) as client:
            await client.list_tools()

    asyncio.run(run())

    assert [name for name, _urn, _payload in published] == ["mcp.client.connected"]
