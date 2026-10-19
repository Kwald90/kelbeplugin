// Estimates — placeholder until the module is built.
export default {
  id: 'estimates',
  title: 'Estimates',
  icon: 'file-text',
  group: 'money',
  perm: 'estimates',
  render(root, { ui }) {
    root.append(ui.page({ title: 'Estimates' }, ui.empty({ icon: 'file-text', title: 'Coming soon' })));
  },
};
