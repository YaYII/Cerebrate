#!/usr/bin/env python3
"""Cerebrate 虫群记忆管理系统 - 主入口"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from cerebrate.cli import main

if __name__ == "__main__":
    main()
