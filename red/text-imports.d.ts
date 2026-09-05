declare module "*.tf" { const content: string; export default content; }
declare module "*.yml" { const content: string; export default content; }
declare module "*.yaml" { const content: string; export default content; }
declare module "*.cfg" { const content: string; export default content; }
declare module "*.ini" { const content: string; export default content; }
declare module "*.sh" { const content: string; export default content; }
declare module "*.j2" { const content: string; export default content; }
// package-once-red's tools.ts imports these text resources; the declarations
// let `tsc --noEmit` follow the dependency the same way clickstack's do.
declare module "*/authorized-keys" { const content: string; export default content; }
declare module "*/deploy" { const content: string; export default content; }
declare module "*/once" { const content: string; export default content; }
