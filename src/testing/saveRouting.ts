import { WorkspaceModel } from '../workspace/workspaceModel';

export type SaveScope = 'current' | 'all' | 'off';

export interface SaveRunPlan {
  appId: string;
  appName: string;
  appPath: string;
}

/**
 * Decide which test runs should fire on file save. Fallback-tier semantics:
 *   - 'current': run tests in the saved file's owning app plus every app
 *     that transitively depends on it.
 *   - 'all': run tests in every app in the workspace.
 *   - 'off': return no runs.
 *
 * Returns [] when scope='current' and the file is outside every AL app.
 */
export function planSaveRuns(
  savedFilePath: string,
  model: WorkspaceModel,
  scope: SaveScope,
): SaveRunPlan[] {
  if (scope === 'off') return [];

  if (scope === 'all') {
    return model.getApps().map(a => ({ appId: a.id, appName: a.name, appPath: a.path }));
  }

  // scope === 'current'
  const owning = model.getAppContaining(savedFilePath);
  if (!owning) return [];
  return model.getDependents(owning.id).map(a => ({ appId: a.id, appName: a.name, appPath: a.path }));
}
