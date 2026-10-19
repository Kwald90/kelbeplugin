// Leads & funnels — placeholder until the module is built.
export default {
  id: 'leads',
  title: 'Leads & funnels',
  icon: 'funnel',
  group: 'sales',
  perm: 'leads',
  render(root, { ui }) {
    root.append(ui.page({ title: 'Leads & funnels' }, ui.empty({ icon: 'funnel', title: 'Coming soon' })));
  },
};
