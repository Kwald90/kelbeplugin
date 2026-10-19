// Sequences — placeholder until the module is built.
export default {
  id: 'sequences',
  title: 'Sequences',
  icon: 'send',
  group: 'sales',
  perm: 'sequences',
  render(root, { ui }) {
    root.append(ui.page({ title: 'Sequences' }, ui.empty({ icon: 'send', title: 'Coming soon' })));
  },
};
