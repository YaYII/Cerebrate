"""Cerebrate client package.

Clients do not own group memory. They only send requests to the authoritative
Brain Server and receive v5 envelopes.
"""

from .http import BrainClient

__all__ = ["BrainClient"]
