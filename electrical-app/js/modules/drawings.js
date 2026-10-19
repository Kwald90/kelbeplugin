// Plans & drawings — placeholder until the module is built.
export default {
  id: 'drawings',
  title: 'Plans & drawings',
  icon: 'pen',
  group: 'work',
  perm: 'drawings',
  render(root, { ui }) {
    root.append(ui.page({ title: 'Plans & drawings' }, ui.empty({ icon: 'pen', title: 'Coming soon' })));
  },
};
