"""The send_feedback nudges added for PRD-4952: error messages and
docstrings steer clients toward reporting problems."""

import asyncio
import json

import pytest

from src import main
from src.main import _error_message, _tool_error


def test_error_message_nudges_on_data_gaps_and_upstream_failures():
    assert "send_feedback" in _error_message(404, "", "Brand not found.")
    assert "send_feedback" in _error_message(500, "boom", "")
    # An unmapped status still carries the original error detail.
    assert "Brandfetch API error (500): boom" in _error_message(500, "boom", "")


@pytest.mark.parametrize("status", [401, 403, 429])
def test_error_message_skips_nudge_on_caller_side_errors(status):
    assert main.FEEDBACK_NUDGE not in _error_message(status, "", "")


@pytest.mark.parametrize("status", [403, 429])
def test_credit_errors_are_named_account_state_not_defects(status):
    """PRD-5181: clients filed 403/429 credit errors as bugs — the message must
    say whose problem it is and steer away from send_feedback."""
    message = _error_message(status, '{"quota": 100, "used": 106}', "")
    assert "do not report it with send_feedback" in message
    assert main.DASHBOARD_URL in message
    assert "brand_search and build_logo_urls do not consume credits" in message
    if status == 429:
        assert "used 106 of 100 credits" in message
        # The overshoot is expected under concurrency; say so before a client
        # reports the counter as a bug.
        assert "past the quota" in message


def test_credit_tools_docstrings_disclaim_account_state():
    tools = {t.name: t for t in asyncio.run(main.mcp.list_tools())}
    for name in ("get_brand", "get_brand_context", "enrich_transaction"):
        description = tools[name].description or ""
        assert "never report it with send_feedback" in description, name
    assert "Do not report credit or quota errors" in (main.mcp.instructions or "")


def test_tool_error_hints_on_eligible_codes():
    for code in ("fetch_failed", "not_found"):
        payload = json.loads(_tool_error(code, "x"))
        assert "send_feedback" in payload["hint"]


@pytest.mark.parametrize(
    "code",
    [
        "invalid_input",
        "hotlink_blocked",
        "asset_too_large",
        # send_feedback's own failure must never nudge toward send_feedback.
        "delivery_failed",
    ],
)
def test_tool_error_has_no_hint_on_excluded_codes(code):
    payload = json.loads(_tool_error(code, "x"))
    assert payload == {"code": code, "message": "x"}


def test_instructions_and_data_quality_tools_mention_send_feedback():
    assert "send_feedback" in (main.mcp.instructions or "")

    tools = {t.name: t for t in asyncio.run(main.mcp.list_tools())}
    for name in ("get_brand", "get_brand_context"):
        assert "send_feedback" in (tools[name].description or ""), name
