// SOPs — placeholder until the module is built.
export default {
  id: 'sops',
  title: 'SOPs',
  icon: 'book',
  group: 'field',
  perm: 'sops',
  render(root, { ui }) {
    root.append(ui.page({ title: 'SOPs' }, ui.empty({ icon: 'book', title: 'Coming soon' })));
  },
};
