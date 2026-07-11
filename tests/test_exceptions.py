import pytest

from epicstaff_mcp.exceptions import (
    EpicStaffAPIError,
    EpicStaffConnectionError,
    EpicStaffError,
    EpicStaffNotFoundError,
)


def test_exception_hierarchy():
    assert issubclass(EpicStaffConnectionError, EpicStaffError)
    assert issubclass(EpicStaffAPIError, EpicStaffError)
    assert issubclass(EpicStaffNotFoundError, EpicStaffAPIError)


def test_api_error_carries_status_and_detail():
    err = EpicStaffAPIError(status_code=422, detail="Validation failed")
    assert err.status_code == 422
    assert "422" in str(err)
    assert "Validation failed" in str(err)
    assert err.remediation is None


def test_api_error_appends_remediation_to_message():
    err = EpicStaffAPIError(
        status_code=400, detail="Bad input", remediation="Do X instead."
    )
    assert err.remediation == "Do X instead."
    assert "Bad input" in str(err)
    assert "Remediation: Do X instead." in str(err)


def test_not_found_error_default_message():
    err = EpicStaffNotFoundError(detail="Agent 99 not found")
    assert err.status_code == 404
    assert err.detail == "Agent 99 not found"
    assert "404" in str(err)
    assert "Agent 99 not found" in str(err)


def test_exceptions_catchable_by_base_types():
    with pytest.raises(EpicStaffError):
        raise EpicStaffNotFoundError(detail="x")
    with pytest.raises(EpicStaffAPIError):
        raise EpicStaffNotFoundError(detail="x")
