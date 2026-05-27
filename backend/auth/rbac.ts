export type Role = 'admin' | 'operator' | 'viewer';

export interface User {
  id: string;
  role: Role;
  permissions: string[];
}

export const PERMISSIONS = {
  READ_RESOURCES: 'read:resources',
  WRITE_RESOURCES: 'write:resources',
  DELETE_RESOURCES: 'delete:resources',
  BULK_IMPORT: 'bulk:import'
} as const;

export const ROLE_PERMISSIONS: Record<Role, string[]> = {
  admin: [
    PERMISSIONS.READ_RESOURCES,
    PERMISSIONS.WRITE_RESOURCES,
    PERMISSIONS.DELETE_RESOURCES,
    PERMISSIONS.BULK_IMPORT
  ],
  operator: [
    PERMISSIONS.READ_RESOURCES,
    PERMISSIONS.WRITE_RESOURCES,
    PERMISSIONS.BULK_IMPORT
  ],
  viewer: [
    PERMISSIONS.READ_RESOURCES
  ]
};

export function hasPermission(user: User, permission: string): boolean {
  return user.permissions.includes(permission);
}

export function getUserFromEvent(event: any): User {
  const role = event.requestContext?.authorizer?.role || 'viewer';
  return {
    id: event.requestContext?.authorizer?.userId || 'anonymous',
    role: role as Role,
    permissions: ROLE_PERMISSIONS[role as Role] || ROLE_PERMISSIONS.viewer
  };
}