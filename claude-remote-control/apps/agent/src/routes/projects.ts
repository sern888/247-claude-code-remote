/**
 * Project-related API routes: listing, folder scanning, and git clone.
 */

import { Router } from 'express';
import { spawn } from 'child_process';
import { access, readdir } from 'fs/promises';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { expandHome, isValidRepoName, resolveInsideBase } from '../lib/validation.js';

const CLONE_TIMEOUT_MS = 5 * 60 * 1000;
const HTTPS_URL_PATTERN = /^https:\/\/.+\/.+/;
const SSH_URL_PATTERN = /^git@.+:.+/;
// user:password@ inside a URL that git may echo back in its error output
const URL_CREDENTIALS_PATTERN = /\/\/[^/\s@]+@/g;

/**
 * Derive the directory name git would clone into.
 * Returns '' when the URL has no usable last path segment.
 */
function extractRepoName(url: string): string {
  if (url.startsWith('git@')) {
    // git@github.com:user/repo.git -> repo
    const pathPart = url.slice(url.indexOf(':') + 1);
    return (
      pathPart
        .split('/')
        .filter(Boolean)
        .pop()
        ?.replace(/\.git$/, '') ?? ''
    );
  }
  // https://github.com/user/repo.git -> repo
  const pathParts = new URL(url).pathname.split('/').filter(Boolean);
  return pathParts[pathParts.length - 1]?.replace(/\.git$/, '') ?? '';
}

/**
 * Last line of git's error output with any credentials removed.
 */
function summarizeGitError(stderr: string): string {
  const lastLine = stderr.trim().split('\n').pop() ?? '';
  return lastLine.replace(URL_CREDENTIALS_PATTERN, '//***@') || 'Git clone failed';
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export function createProjectRoutes(): Router {
  const router = Router();

  // List whitelisted projects
  router.get('/projects', (_req, res) => {
    res.json(config.projects.whitelist);
  });

  // Dynamic folder listing - scans basePath for directories
  router.get('/folders', async (_req, res) => {
    try {
      const basePath = expandHome(config.projects.basePath);

      const entries = await readdir(basePath, { withFileTypes: true });
      const folders = entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
        .sort();

      res.json(folders);
    } catch (err) {
      logger.server.error({ err }, 'Failed to list folders');
      res.status(500).json({ error: 'Failed to list folders' });
    }
  });

  // Clone a git repository
  router.post('/clone', async (req, res) => {
    const { url } = (req.body ?? {}) as { url?: unknown };

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ success: false, error: 'URL is required' });
    }

    // Validate URL format (https:// or git@)
    if (!HTTPS_URL_PATTERN.test(url) && !SSH_URL_PATTERN.test(url)) {
      return res.status(400).json({ success: false, error: 'Invalid URL format' });
    }

    let repoName: string;
    try {
      repoName = extractRepoName(url);
    } catch (_err) {
      return res.status(400).json({ success: false, error: 'Invalid URL format' });
    }

    // The name is passed to git as an argument and joined into a path:
    // it must not look like an option ("--config=...") or leave basePath.
    const basePath = expandHome(config.projects.basePath);
    const targetPath = isValidRepoName(repoName) ? resolveInsideBase(basePath, repoName) : null;
    if (!targetPath) {
      return res
        .status(400)
        .json({ success: false, error: 'Could not extract repo name from URL' });
    }

    if (await pathExists(targetPath)) {
      return res.status(400).json({
        success: false,
        error: `Folder "${repoName}" already exists`,
      });
    }

    // Clone the repository. "--" ends option parsing; the ext transport
    // (which runs arbitrary commands) is disabled.
    return new Promise<void>((resolve) => {
      const gitProcess = spawn(
        'git',
        ['-c', 'protocol.ext.allow=never', 'clone', '--', url, repoName],
        { cwd: basePath, env: process.env, timeout: CLONE_TIMEOUT_MS }
      );

      let stderr = '';

      gitProcess.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      gitProcess.on('close', (code) => {
        if (code === 0) {
          logger.server.info({ project: repoName }, 'Cloned repository');
          res.json({
            success: true,
            project: repoName,
            path: targetPath,
          });
        } else {
          const error = summarizeGitError(stderr);
          logger.server.error({ project: repoName, code, error }, 'Git clone failed');
          res.status(500).json({ success: false, error });
        }
        resolve();
      });

      gitProcess.on('error', (err) => {
        logger.server.error({ err }, 'Failed to spawn git');
        res.status(500).json({
          success: false,
          error: 'Failed to execute git command',
        });
        resolve();
      });
    });
  });

  return router;
}
