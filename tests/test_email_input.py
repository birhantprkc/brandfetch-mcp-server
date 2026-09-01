"""The email input form: what the event bus is allowed to carry.

The endpoints themselves do the resolving — the seam this server owns is reducing
an email identifier to its domain before it is published to the event bus.
"""

from src.main import _domain_only


class TestDomainOnly:
    def test_reduces_an_email_to_its_domain(self) -> None:
        assert _domain_only("john@nike.com") == "nike.com"

    def test_splits_on_the_last_at(self) -> None:
        assert _domain_only("a@b@0box.eu") == "0box.eu"

    def test_leaves_non_email_identifiers_unchanged(self) -> None:
        assert _domain_only("nike.com") == "nike.com"
        assert _domain_only("NKE") == "NKE"
        assert _domain_only("US6541061031") == "US6541061031"

    def test_reduces_the_percent_encoded_spelling_the_same_way(self) -> None:
        assert _domain_only("john%40nike.com") == "nike.com"
        assert _domain_only("john%40nike.com".upper()) == "NIKE.COM"

    def test_leaves_a_percent_sign_without_an_encoded_at_alone(self) -> None:
        assert _domain_only("100%valid") == "100%valid"
