"""get_brand and get_brand_data are one lookup with two presentations: the card
tool steers single-brand viewing, the data tool steers multi-brand and
data-as-input work, and everything about the response is documented once."""

import asyncio
import json

import httpx
import pytest

from src import main


def _descriptions() -> dict[str, str]:
    tools = {t.name: t for t in asyncio.run(main.mcp.list_tools())}
    return {name: tools[name].description or "" for name in ("get_brand", "get_brand_data")}


@pytest.mark.parametrize(
    "block",
    [
        main._BRAND_LOOKUP_DOC,
        main._BRAND_RESPONSE_DOC,
        main._BRAND_URL_RULES_DOC,
        main._BRAND_ERRORS_DOC,
    ],
)
def test_shared_blocks_appear_verbatim_in_both_descriptions(block):
    for name, description in _descriptions().items():
        assert block in description, name


def test_each_tool_names_the_other():
    descriptions = _descriptions()
    assert "`get_brand_data`" in descriptions["get_brand"]
    assert "`get_brand`" in descriptions["get_brand_data"]


def test_steering_splits_one_brand_to_view_from_many_brands_as_input():
    descriptions = _descriptions()
    card = descriptions["get_brand"]
    data = descriptions["get_brand_data"]

    assert "ONE brand" in card
    assert "interactive brand profile" in card
    assert "once per brand for a multi-brand request" in card

    assert "no interactive card" in data
    assert "several brands" in data
    assert "logo walls" in data
    # Only the card tool documents the tab deep-link.
    assert "`view`" in card
    assert "`view`" not in data


def test_other_tools_route_multi_brand_work_to_get_brand_data():
    tools = {t.name: t.description or "" for t in asyncio.run(main.mcp.list_tools())}
    assert "get_brand_data" in tools["brand_search"]
    assert "get_brand_data" in tools["build_logo_urls"]
    assert "get_brand_data" in tools["get_brand_context"]


class _FakeAsyncClient:
    """Stands in for httpx.AsyncClient: answers every GET with the canned brand."""

    response = httpx.Response(
        200,
        text=json.dumps({"domain": "nike.com", "logos": []}),
        request=httpx.Request("GET", "https://api.example/brands/nike.com"),
    )

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, *args, **kwargs):
        return self.response


@pytest.fixture
def published(monkeypatch):
    events: list[tuple[str, dict]] = []
    monkeypatch.setattr(main.httpx, "AsyncClient", _FakeAsyncClient)
    monkeypatch.setattr(
        main, "_publish_event", lambda name, payload: events.append((name, payload))
    )
    monkeypatch.setattr(main, "_get_api_key", lambda: "test-key")
    return events


def test_card_tool_publishes_the_fetch_and_the_card_events(published):
    asyncio.run(main.get_brand("owner@brandfetch.test"))

    assert [name for name, _ in published] == [
        main.BRAND_FETCHED_EVENT,
        main.BRAND_CARD_SERVED_EVENT,
    ]
    # The same payload goes out under both names, mailbox already reduced to its domain.
    assert published[0][1] == published[1][1]
    assert published[0][1]["identifier"] == "brandfetch.test"
    assert published[0][1]["success"] is True


def test_data_tool_publishes_only_the_fetch_event(published):
    result = asyncio.run(main.get_brand_data("nike.com"))

    assert [name for name, _ in published] == [main.BRAND_FETCHED_EVENT]
    assert json.loads(result.content[0].text)["domain"] == "nike.com"


def test_both_tools_return_the_same_result(published):
    card = asyncio.run(main.get_brand("nike.com"))
    data = asyncio.run(main.get_brand_data("nike.com"))

    assert card.content == data.content
