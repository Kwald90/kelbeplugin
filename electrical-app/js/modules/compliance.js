// Compliance — placeholder until the module is built.
export default {
  id: 'compliance',
  title: 'Compliance',
  icon: 'shield-check',
  group: 'field',
  perm: 'compliance',
  render(root, { ui }) {
    root.append(ui.page({ title: 'Compliance' }, ui.empty({ icon: 'shield-check', title: 'Coming soon' })));
  },
};
