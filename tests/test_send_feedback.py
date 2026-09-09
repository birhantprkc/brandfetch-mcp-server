import asyncio
import json

import pytest

from src import main
from src.utils import events

WEBHOOK_URL = "https://hooks.slack.com/services/T000/B000/fake"


class _FakeResponse:
    def __init__(self, status_code: int):
        self.status_code = status_code
        self.text = ""

    @property
    def is_success(self) -> bool:
        return 200 <= self.status_code < 300


class _FakeAsyncClient:
    """Stands in for httpx.AsyncClient; records posts on the class."""

    posts: list[tuple[str, dict]] = []
    status_code = 200

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc_info):
        return False

    async def post(self, url, json=None):
        type(self).posts.append((url, json))
        return _FakeResponse(type(self).status_code)


@pytest.fixture
def slack(monkeypatch):
    _FakeAsyncClient.posts = []
    _FakeAsyncClient.status_code = 200
    monkeypatch.setattr(main.httpx, "AsyncClient", _FakeAsyncClient)
    monkeypatch.setenv("SLACK_FEEDBACK_WEBHOOK_URL", WEBHOOK_URL)
    monkeypatch.setenv("STAGE", "unit-test")
    return _FakeAsyncClient


@pytest.fixture
def published(monkeypatch):
    calls: list[tuple[str, str, dict]] = []
    monkeypatch.setattr(
        events, "publish", lambda name, urn, payload: calls.append((name, urn, payload))
    )
    return calls


def _send(**kwargs):
    return asyncio.run(main.send_feedback(**kwargs))


def test_send_feedback_posts_to_slack_and_acks(slack, published):
    result = json.loads(
        _send(
            message="get_brand returned a stale logo",
            category="data-quality",
            tool_name="get_brand",
        )
    )

    assert result["status"] == "received"
    assert "feedback" in result["message"]

    assert len(slack.posts) == 1
    url, payload = slack.posts[0]
    assert url == WEBHOOK_URL
    # The stage leads the message so one shared webhook can serve every
    # environment.
    assert payload["text"].startswith("[unit-test]")
    assert payload["blocks"][0]["elements"][0]["text"] == "[unit-test]"
    assert payload["blocks"][2]["text"]["text"] == "get_brand returned a stale logo"
    context_text = payload["blocks"][3]["elements"][0]["text"]
    assert "data-quality" in context_text
    assert "get_brand" in context_text

    assert len(published) == 1
    name, _urn, event_payload = published[0]
    assert name == "mcp.feedback.submitted"
    assert event_payload["category"] == "data-quality"
    assert event_payload["toolName"] == "get_brand"
    assert event_payload["delivered"] is True


def test_send_feedback_rejects_empty_message(slack, published):
    with pytest.raises(ValueError) as exc_info:
        _send(message="   ")

    assert json.loads(str(exc_info.value))["code"] == "invalid_input"
    assert slack.posts == []
    assert published == []


def test_send_feedback_without_webhook_still_acks(monkeypatch, slack, published):
    monkeypatch.delenv("SLACK_FEEDBACK_WEBHOOK_URL")

    result = json.loads(_send(message="missing font data for nike.com"))

    assert result["status"] == "received"
    assert slack.posts == []
    assert len(published) == 1
    assert published[0][2]["delivered"] is False


def test_send_feedback_raises_when_slack_delivery_fails(slack, published):
    slack.status_code = 500

    with pytest.raises(ValueError) as exc_info:
        _send(message="some feedback")

    assert json.loads(str(exc_info.value))["code"] == "delivery_failed"
    # The event trail still records the attempt.
    assert len(published) == 1
    assert published[0][2]["delivered"] is False


def test_send_feedback_truncates_long_messages(slack, published):
    result = json.loads(_send(message="x" * 5000))

    assert result["status"] == "received"
    _url, payload = slack.posts[0]
    posted_text = payload["blocks"][2]["text"]["text"]
    assert len(posted_text) <= main.FEEDBACK_MAX_CHARS + len("… [truncated]")
    assert posted_text.endswith("… [truncated]")
    assert published[0][2]["truncated"] is True


def test_send_feedback_escapes_slack_control_characters(slack, published):
    _send(message="tags like <script> & <b> broke")

    _url, payload = slack.posts[0]
    assert payload["blocks"][2]["text"]["text"] == "tags like &lt;script&gt; &amp; &lt;b&gt; broke"


# Verbatim shapes of the credit / quota reports that reached #mcp-server
# before PRD-5181 (trimmed), each filed as a defect.
ACCOUNT_STATE_REPORTS = [
    "All three returned 403 'no available API credits or does not have access'. "
    + "Expected at least the well-known Apple/Cisco brand records to be accessible.",
    'get_brand began failing with: "API quota exhausted (used 106 of 100 credits)". '
    + "The counter went 6 credits PAST the limit before the tool started refusing calls.",
    "every call returned Forbidden because the API key had no available credits or access.",
    "get_brand returned Forbidden: no API credits, or the key does not have access. "
    + "Expected structured brand assets.",
    "Expected: either continued success, or a distinct rate-limit error (429) — "
    + "the quota was hit mid-batch.",
]

# Legitimate reports that share vocabulary with the account-state ones.
ACTIONABLE_REPORTS = [
    "Credentialed src URLs for youtube.com fetched with curl: the first SVG request "
    + "returned HTTP 403. Expected direct download to succeed per tool documentation.",
    "enrich_transaction mis-resolved the credit card statement line 'SQ *BLUE BOTTLE' "
    + "to the wrong merchant.",
    "get_brand(iheald.com) returns a longDescription about an unrelated skincare brand.",
    'brand_search with query "99% Invisible" returned a CloudFront 400 HTML error.',
    "Praise: the user built a branded template from carrefour.fr data and was happy.",
    # Capability requests that mention credits are product feedback, not
    # account state.
    "Feature request: expose the API credits available in each get_brand response "
    + "so batch jobs can throttle before the quota runs low.",
    "A credits-remaining field or a quota/balance tool would help plan batch work.",
]


@pytest.mark.parametrize("message", ACCOUNT_STATE_REPORTS)
def test_send_feedback_declines_credit_and_quota_reports(slack, published, message):
    result = json.loads(_send(message=message, category="bug", tool_name="get_brand"))

    assert result["status"] == "declined"
    assert result["reason"] == "account_state"
    assert main.DASHBOARD_URL in result["message"]
    # Nothing reaches Slack; the event trail still records the attempt.
    assert slack.posts == []
    assert len(published) == 1
    event_payload = published[0][2]
    assert event_payload["declined"] == "account_state"
    assert event_payload["delivered"] is False
    assert event_payload["toolName"] == "get_brand"


@pytest.mark.parametrize("message", ACTIONABLE_REPORTS)
def test_send_feedback_keeps_delivering_actionable_reports(slack, published, message):
    result = json.loads(_send(message=message))

    assert result["status"] == "received"
    assert len(slack.posts) == 1
    assert "declined" not in published[0][2]


def test_account_state_needs_both_the_resource_and_a_failure():
    # The vocabulary alone is not a credit report.
    assert not main._is_account_state_feedback("Please add a credits-remaining field.")
    assert not main._is_account_state_feedback("Show the credits available per key.")
    assert not main._is_account_state_feedback("The CDN answered 403 for the SVG.")
    assert main._is_account_state_feedback("403: no API credits left on this key.")
    assert main._is_account_state_feedback("The key has no available credits.")
