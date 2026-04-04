export type TokenScopeType = "package:read" | "package:write" | "package:read+write";

export type TokenRow = {
	token: string;
	name: string;
	scopes: string;
	created_at: number;
	updated_at: number;
};

export type ParsedScope = {
	type: string;
	values: string[];
};

export type PackagePerms = {
	read: boolean;
	write: boolean;
	types: string[];
};

export type CreateTokenArgs = {
	packages?: string[];
	mode?: TokenScopeType;
	name?: string;
	local: boolean;
};

export type ClearTokensArgs = {
	package?: string;
	local: boolean;
};

export type RemoveTokenArgs = {
	token?: string;
	local: boolean;
};

export type ListTokensArgs = {
	package?: string;
	local: boolean;
	skipIntro?: boolean;
};

export type ListScopeArgs = {
	scope?: string;
	local: boolean;
	skipIntro?: boolean;
};

export type LookupTokenArgs = {
	token?: string;
	local: boolean;
};
