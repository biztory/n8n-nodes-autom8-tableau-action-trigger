import type { Icon, ICredentialType, INodeProperties } from 'n8n-workflow';

// eslint-disable-next-line @n8n/community-nodes/credential-test-required
export class Autom8TableauBearerApi implements ICredentialType {
  name = 'autom8TableauBearerApi';
  displayName = 'Autom8 Tableau – Bearer Token API';
  icon: Icon = { light: 'file:../icons/autom8-action-light.svg', dark: 'file:../icons/autom8-action-dark.svg' };
  documentationUrl = "https://biztory.atlassian.net/wiki/spaces/A8/pages/1122336771/Authentication";
  properties: INodeProperties[] = [
    {
      displayName: 'Bearer Token',
      name: 'token',
      type: 'string',
      typeOptions: { password: true },
      required: true,
      default: '',
    },
  ];
}
