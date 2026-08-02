"""Harbor integration for the WoopCode CLI coding agent.

Exposes :class:`WoopCode`, a :class:`~harbor.agents.installed.base.BaseInstalledAgent`
that installs and drives the ``woopcode`` CLI inside a Harbor environment.

Register it with Harbor by import path::

    harbor run -d terminal-bench/terminal-bench-2 -a harbor_woopcode:WoopCode
"""

from harbor_woopcode.agent import WoopCode

__all__ = ["WoopCode"]
