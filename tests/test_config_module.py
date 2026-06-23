import pytest
from pydantic import ValidationError

from epicstaff_mcp.config import AuthMode, Settings, get_settings


def test_no_auth_mode(monkeypatch):
    monkeypatch.setenv("EPICSTAFF_BASE_URL", "http://localhost:8000")
    s = Settings()
    assert s.auth_mode == AuthMode.NONE
    assert s.base_url == "http://localhost:8000/"  # trailing slash added


def test_api_key_auth_mode(monkeypatch):
    monkeypatch.setenv("EPICSTAFF_BASE_URL", "http://localhost:8000")
    monkeypatch.setenv("EPICSTAFF_API_TOKEN", "mytoken")
    s = Settings()
    assert s.auth_mode == AuthMode.API_KEY


def test_x_api_key_auth_mode(monkeypatch):
    monkeypatch.setenv("EPICSTAFF_BASE_URL", "http://localhost:8000")
    monkeypatch.setenv("EPICSTAFF_API_KEY", "epicstaff_key")
    s = Settings()
    assert s.auth_mode == AuthMode.X_API_KEY


def test_api_key_and_token_ambiguous_raises(monkeypatch):
    monkeypatch.setenv("EPICSTAFF_BASE_URL", "http://localhost:8000")
    monkeypatch.setenv("EPICSTAFF_API_KEY", "k")
    monkeypatch.setenv("EPICSTAFF_API_TOKEN", "t")
    with pytest.raises(ValidationError, match="Ambiguous"):
        Settings()


def test_basic_auth_mode(monkeypatch):
    monkeypatch.setenv("EPICSTAFF_BASE_URL", "http://localhost:8000")
    monkeypatch.setenv("EPICSTAFF_USERNAME", "user")
    monkeypatch.setenv("EPICSTAFF_PASSWORD", "pass")
    s = Settings()
    assert s.auth_mode == AuthMode.BASIC


def test_missing_base_url_raises(monkeypatch):
    monkeypatch.delenv("EPICSTAFF_BASE_URL", raising=False)
    with pytest.raises(ValidationError):
        Settings()


def test_username_without_password_raises(monkeypatch):
    monkeypatch.setenv("EPICSTAFF_BASE_URL", "http://localhost:8000")
    monkeypatch.setenv("EPICSTAFF_USERNAME", "user")
    with pytest.raises(ValidationError, match="PASSWORD"):
        Settings()


def test_ambiguous_auth_raises(monkeypatch):
    monkeypatch.setenv("EPICSTAFF_BASE_URL", "http://localhost:8000")
    monkeypatch.setenv("EPICSTAFF_API_TOKEN", "tok")
    monkeypatch.setenv("EPICSTAFF_USERNAME", "user")
    monkeypatch.setenv("EPICSTAFF_PASSWORD", "pass")
    with pytest.raises(ValidationError, match="Ambiguous"):
        Settings()


def test_defaults(monkeypatch):
    monkeypatch.setenv("EPICSTAFF_BASE_URL", "http://localhost:8000")
    s = Settings()
    assert s.timeout == 30.0
    assert s.max_retries == 3


def test_get_settings(monkeypatch):
    get_settings.cache_clear()
    monkeypatch.setenv("EPICSTAFF_BASE_URL", "http://localhost:8000")
    s = get_settings()
    assert isinstance(s, Settings)
    assert s.base_url == "http://localhost:8000/"  # note: trailing slash normalized
    get_settings.cache_clear()


def test_invalid_base_url_raises(monkeypatch):
    monkeypatch.setenv("EPICSTAFF_BASE_URL", "localhost:8000")
    with pytest.raises(ValidationError, match="http"):
        Settings()


def test_base_url_gets_trailing_slash(monkeypatch):
    monkeypatch.setenv("EPICSTAFF_BASE_URL", "http://localhost:8000")
    s = Settings()
    assert s.base_url == "http://localhost:8000/"
