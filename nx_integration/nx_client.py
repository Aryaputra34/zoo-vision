"""
Nx Meta / Nx Witness REST API v3 Client
Handles authentication, session management, bookmark creation, and event dispatch.
Includes a transparent mock mode for offline local testing.
"""

import time
import logging
import requests
from typing import List, Optional, Dict, Any

logger = logging.getLogger("NxClient")


class NxClient:
    def __init__(
        self,
        host: str = "127.0.0.1",
        port: int = 7001,
        username: str = "admin",
        password: str = "admin",
        token: str = "",
        use_https: bool = True,
        verify_ssl: bool = False,
        mock_mode: bool = False
    ):
        self.host = host
        self.port = port
        self.username = username
        self.password = password
        self.token = token
        self.use_https = use_https
        self.verify_ssl = verify_ssl
        self.mock_mode = mock_mode

        protocol = "https" if use_https else "http"
        self.base_url = f"{protocol}://{host}:{port}"
        self.session = requests.Session()
        
        # Suppress insecure HTTPS warning if self-signed cert is used
        if not verify_ssl:
            import urllib3
            urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

        if not self.mock_mode:
            self._authenticate()

    def _authenticate(self) -> bool:
        """Authenticate with Nx Server using REST API v3 session or bearer token."""
        if self.token:
            self.session.headers.update({"Authorization": f"Bearer {self.token}"})
            return True

        login_url = f"{self.base_url}/rest/v3/login/sessions"
        payload = {"username": self.username, "password": self.password}

        try:
            resp = self.session.post(login_url, json=payload, verify=self.verify_ssl, timeout=5.0)
            if resp.status_code in [200, 201]:
                data = resp.json()
                self.token = data.get("token", "")
                self.session.headers.update({"Authorization": f"Bearer {self.token}"})
                logger.info(f"Successfully authenticated with Nx Server at {self.base_url}")
                return True
            else:
                logger.warning(f"Nx Server auth failed (HTTP {resp.status_code}): {resp.text}. Falling back to mock mode.")
                self.mock_mode = True
                return False
        except requests.exceptions.RequestException as e:
            logger.warning(f"Could not connect to Nx Server at {self.base_url}: {e}. Operating in mock mode.")
            self.mock_mode = True
            return False

    def create_bookmark(
        self,
        camera_id: str,
        title: str,
        description: str,
        tags: List[str],
        start_time_ms: Optional[int] = None,
        duration_ms: int = 10000
    ) -> bool:
        """
        Creates an audit bookmark on the Nx camera timeline.
        Visible in Nx Desktop Client timeline and bookmark search panel.
        """
        if start_time_ms is None:
            start_time_ms = int(time.time() * 1000)

        payload = {
            "cameraId": camera_id,
            "name": title,
            "description": description,
            "tags": tags,
            "startTimeMs": start_time_ms,
            "durationMs": duration_ms
        }

        if self.mock_mode:
            logger.info(
                f"[MOCK Nx BOOKMARK] Camera: {camera_id} | Title: {title} | Tags: {tags}\n"
                f"       Details: {description} (Start: {start_time_ms}, Duration: {duration_ms}ms)"
            )
            return True

        url = f"{self.base_url}/rest/v3/bookmarks"
        try:
            resp = self.session.post(url, json=payload, verify=self.verify_ssl, timeout=4.0)
            if resp.status_code in [200, 201]:
                logger.info(f"Created Nx Bookmark: '{title}' (ID: {resp.json().get('id', 'N/A')})")
                return True
            elif resp.status_code == 401:
                # Token expired, re-auth once
                if self._authenticate():
                    return self.create_bookmark(camera_id, title, description, tags, start_time_ms, duration_ms)
            logger.error(f"Failed to create Nx Bookmark (HTTP {resp.status_code}): {resp.text}")
            return False
        except requests.exceptions.RequestException as e:
            logger.error(f"Error sending bookmark to Nx Server: {e}")
            return False

    def create_event(
        self,
        event_type: str,
        source: str,
        caption: str,
        description: str,
        metadata: Optional[Dict[str, Any]] = None
    ) -> bool:
        """
        Fires an Nx Generic/Analytics Event.
        Triggers Desktop Client popup notifications, alarms, and PTZ actions.
        """
        payload = {
            "source": source,
            "caption": caption,
            "description": description,
            "metadata": metadata or {}
        }

        if self.mock_mode:
            logger.info(
                f"[MOCK Nx ALARM EVENT] Source: {source} | Caption: {caption}\n"
                f"       Details: {description}"
            )
            return True

        url = f"{self.base_url}/rest/v3/events"
        try:
            resp = self.session.post(url, json=payload, verify=self.verify_ssl, timeout=4.0)
            return resp.status_code in [200, 201]
        except requests.exceptions.RequestException as e:
            logger.error(f"Error sending event to Nx Server: {e}")
            return False
