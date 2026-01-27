<?php
/**
 * Admin Users Management
 *
 * Handles user management enhancements for project tracking.
 *
 * @package Kelbe_Project_Tracker
 * @since 1.0.0
 */

// Exit if accessed directly
if (!defined('ABSPATH')) {
    exit;
}

/**
 * Class KPT_Admin_Users
 */
class KPT_Admin_Users {
    
    /**
     * Single instance of the class
     *
     * @var KPT_Admin_Users
     */
    private static $instance = null;
    
    /**
     * Get instance
     *
     * @return KPT_Admin_Users
     */
    public static function get_instance() {
        if (null === self::$instance) {
            self::$instance = new self();
        }
        return self::$instance;
    }
    
    /**
     * Constructor
     */
    private function __construct() {
        add_action('show_user_profile', array($this, 'add_user_profile_fields'));
        add_action('edit_user_profile', array($this, 'add_user_profile_fields'));
        add_action('personal_options_update', array($this, 'save_user_profile_fields'));
        add_action('edit_user_profile_update', array($this, 'save_user_profile_fields'));
        add_action('admin_menu', array($this, 'add_user_management_page'));
        add_action('admin_enqueue_scripts', array($this, 'enqueue_scripts'));
        add_filter('manage_users_columns', array($this, 'add_user_columns'));
        add_filter('manage_users_custom_column', array($this, 'render_user_column'), 10, 3);
        add_action('wp_ajax_kpt_bulk_assign_users', array($this, 'ajax_bulk_assign_users'));
        add_action('wp_ajax_kpt_update_user_capabilities', array($this, 'ajax_update_user_capabilities'));
    }
    
    /**
     * Add custom user profile fields
     *
     * @param WP_User $user User object
     */
    public function add_user_profile_fields($user) {
        if (!current_user_can('edit_users')) {
            return;
        }
        
        $portal_role = get_user_meta($user->ID, 'kpt_portal_role', true);
        $trade_type = get_user_meta($user->ID, 'kpt_trade_type', true);
        $company_name = get_user_meta($user->ID, 'kpt_company_name', true);
        $hourly_rate = get_user_meta($user->ID, 'kpt_hourly_rate', true);
        
        $settings = get_option('kpt_settings', array());
        $trade_types = isset($settings['trade_types']) ? $settings['trade_types'] : array();
        
        ?>
        <h2><?php _e('Kelbe Project Tracker Settings', 'kelbe-project-tracker'); ?></h2>
        <table class="form-table">
            <tr>
                <th>
                    <label for="kpt_portal_role"><?php _e('Portal Role', 'kelbe-project-tracker'); ?></label>
                </th>
                <td>
                    <select id="kpt_portal_role" name="kpt_portal_role" class="regular-text">
                        <option value=""><?php _e('Select Role', 'kelbe-project-tracker'); ?></option>
                        <option value="administrator" <?php selected($portal_role, 'administrator'); ?>><?php _e('Administrator', 'kelbe-project-tracker'); ?></option>
                        <option value="project_manager" <?php selected($portal_role, 'project_manager'); ?>><?php _e('Project Manager', 'kelbe-project-tracker'); ?></option>
                        <option value="contractor" <?php selected($portal_role, 'contractor'); ?>><?php _e('Contractor', 'kelbe-project-tracker'); ?></option>
                        <option value="client" <?php selected($portal_role, 'client'); ?>><?php _e('Client', 'kelbe-project-tracker'); ?></option>
                    </select>
                    <p class="description"><?php _e('Role within the project tracker system', 'kelbe-project-tracker'); ?></p>
                </td>
            </tr>
            <tr>
                <th>
                    <label for="kpt_trade_type"><?php _e('Trade Type', 'kelbe-project-tracker'); ?></label>
                </th>
                <td>
                    <select id="kpt_trade_type" name="kpt_trade_type" class="regular-text">
                        <option value=""><?php _e('Select Trade Type', 'kelbe-project-tracker'); ?></option>
                        <?php foreach ($trade_types as $index => $type): ?>
                            <option value="<?php echo esc_attr($index); ?>" <?php selected($trade_type, $index); ?>>
                                <?php echo esc_html($type['name']); ?>
                            </option>
                        <?php endforeach; ?>
                    </select>
                    <p class="description"><?php _e('Applicable for contractors', 'kelbe-project-tracker'); ?></p>
                </td>
            </tr>
            <tr>
                <th>
                    <label for="kpt_company_name"><?php _e('Company Name', 'kelbe-project-tracker'); ?></label>
                </th>
                <td>
                    <input type="text" id="kpt_company_name" name="kpt_company_name" 
                           value="<?php echo esc_attr($company_name); ?>" class="regular-text">
                    <p class="description"><?php _e('Company or business name', 'kelbe-project-tracker'); ?></p>
                </td>
            </tr>
            <tr>
                <th>
                    <label for="kpt_hourly_rate"><?php _e('Hourly Rate', 'kelbe-project-tracker'); ?></label>
                </th>
                <td>
                    <input type="number" id="kpt_hourly_rate" name="kpt_hourly_rate" 
                           value="<?php echo esc_attr($hourly_rate); ?>" 
                           class="small-text" min="0" step="0.01">
                    <p class="description"><?php _e('Default hourly rate for time tracking', 'kelbe-project-tracker'); ?></p>
                </td>
            </tr>
        </table>
        <?php
    }
    
    /**
     * Save custom user profile fields
     *
     * @param int $user_id User ID
     */
    public function save_user_profile_fields($user_id) {
        if (!current_user_can('edit_users')) {
            return;
        }
        
        check_admin_referer('update-user_' . $user_id);
        
        if (isset($_POST['kpt_portal_role'])) {
            update_user_meta($user_id, 'kpt_portal_role', sanitize_text_field($_POST['kpt_portal_role']));
        }
        
        if (isset($_POST['kpt_trade_type'])) {
            update_user_meta($user_id, 'kpt_trade_type', sanitize_text_field($_POST['kpt_trade_type']));
        }
        
        if (isset($_POST['kpt_company_name'])) {
            update_user_meta($user_id, 'kpt_company_name', sanitize_text_field($_POST['kpt_company_name']));
        }
        
        if (isset($_POST['kpt_hourly_rate'])) {
            update_user_meta($user_id, 'kpt_hourly_rate', floatval($_POST['kpt_hourly_rate']));
        }
    }
    
    /**
     * Add user management page
     */
    public function add_user_management_page() {
        add_submenu_page(
            'users.php',
            __('Project User Management', 'kelbe-project-tracker'),
            __('Project Users', 'kelbe-project-tracker'),
            'manage_options',
            'kpt-user-management',
            array($this, 'render_user_management_page')
        );
    }
    
    /**
     * Render user management page
     */
    public function render_user_management_page() {
        if (!current_user_can('manage_options')) {
            wp_die(__('You do not have sufficient permissions to access this page.', 'kelbe-project-tracker'));
        }
        
        $action = isset($_GET['action']) ? sanitize_key($_GET['action']) : 'list';
        
        ?>
        <div class="wrap">
            <h1><?php echo esc_html(get_admin_page_title()); ?></h1>
            
            <?php
            switch ($action) {
                case 'bulk_assign':
                    $this->render_bulk_assign_form();
                    break;
                case 'manage_capabilities':
                    $this->render_capabilities_form();
                    break;
                default:
                    $this->render_user_list();
                    break;
            }
            ?>
        </div>
        <?php
    }
    
    /**
     * Render user list
     */
    private function render_user_list() {
        $users = get_users(array('orderby' => 'display_name'));
        
        ?>
        <div class="kpt-user-actions">
            <a href="<?php echo esc_url(add_query_arg('action', 'bulk_assign')); ?>" class="button button-primary">
                <?php _e('Bulk Assign to Projects', 'kelbe-project-tracker'); ?>
            </a>
            <a href="<?php echo esc_url(add_query_arg('action', 'manage_capabilities')); ?>" class="button">
                <?php _e('Manage Capabilities', 'kelbe-project-tracker'); ?>
            </a>
        </div>
        
        <table class="wp-list-table widefat fixed striped">
            <thead>
                <tr>
                    <th><?php _e('User', 'kelbe-project-tracker'); ?></th>
                    <th><?php _e('Email', 'kelbe-project-tracker'); ?></th>
                    <th><?php _e('Portal Role', 'kelbe-project-tracker'); ?></th>
                    <th><?php _e('Trade Type', 'kelbe-project-tracker'); ?></th>
                    <th><?php _e('Company', 'kelbe-project-tracker'); ?></th>
                    <th><?php _e('Projects', 'kelbe-project-tracker'); ?></th>
                    <th><?php _e('Actions', 'kelbe-project-tracker'); ?></th>
                </tr>
            </thead>
            <tbody>
                <?php foreach ($users as $user): ?>
                    <?php
                    $portal_role = get_user_meta($user->ID, 'kpt_portal_role', true);
                    $trade_type = get_user_meta($user->ID, 'kpt_trade_type', true);
                    $company_name = get_user_meta($user->ID, 'kpt_company_name', true);
                    $project_count = $this->get_user_project_count($user->ID);
                    ?>
                    <tr>
                        <td><strong><?php echo esc_html($user->display_name); ?></strong></td>
                        <td><?php echo esc_html($user->user_email); ?></td>
                        <td><?php echo esc_html($this->get_portal_role_label($portal_role)); ?></td>
                        <td><?php echo esc_html($this->get_trade_type_label($trade_type)); ?></td>
                        <td><?php echo esc_html($company_name); ?></td>
                        <td><?php echo absint($project_count); ?></td>
                        <td>
                            <a href="<?php echo esc_url(get_edit_user_link($user->ID)); ?>" class="button button-small">
                                <?php _e('Edit', 'kelbe-project-tracker'); ?>
                            </a>
                        </td>
                    </tr>
                <?php endforeach; ?>
            </tbody>
        </table>
        <?php
    }
    
    /**
     * Render bulk assign form
     */
    private function render_bulk_assign_form() {
        $users = get_users(array('orderby' => 'display_name'));
        $projects = get_posts(array(
            'post_type' => 'kpt_project',
            'posts_per_page' => -1,
            'orderby' => 'title',
            'order' => 'ASC'
        ));
        
        ?>
        <div class="kpt-bulk-assign-form">
            <h2><?php _e('Bulk Assign Users to Projects', 'kelbe-project-tracker'); ?></h2>
            
            <form method="post" id="kpt-bulk-assign-form">
                <?php wp_nonce_field('kpt_bulk_assign', 'kpt_bulk_assign_nonce'); ?>
                
                <table class="form-table">
                    <tr>
                        <th scope="row">
                            <label for="users"><?php _e('Select Users', 'kelbe-project-tracker'); ?></label>
                        </th>
                        <td>
                            <select id="users" name="users[]" multiple size="10" style="width: 300px;">
                                <?php foreach ($users as $user): ?>
                                    <option value="<?php echo esc_attr($user->ID); ?>">
                                        <?php echo esc_html($user->display_name); ?> (<?php echo esc_html($user->user_email); ?>)
                                    </option>
                                <?php endforeach; ?>
                            </select>
                            <p class="description"><?php _e('Hold Ctrl/Cmd to select multiple users', 'kelbe-project-tracker'); ?></p>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row">
                            <label for="projects"><?php _e('Select Projects', 'kelbe-project-tracker'); ?></label>
                        </th>
                        <td>
                            <select id="projects" name="projects[]" multiple size="10" style="width: 300px;">
                                <?php foreach ($projects as $project): ?>
                                    <option value="<?php echo esc_attr($project->ID); ?>">
                                        <?php echo esc_html($project->post_title); ?>
                                    </option>
                                <?php endforeach; ?>
                            </select>
                            <p class="description"><?php _e('Hold Ctrl/Cmd to select multiple projects', 'kelbe-project-tracker'); ?></p>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row">
                            <label for="role"><?php _e('Assign as', 'kelbe-project-tracker'); ?></label>
                        </th>
                        <td>
                            <select id="role" name="role">
                                <option value="member"><?php _e('Team Member', 'kelbe-project-tracker'); ?></option>
                                <option value="lead"><?php _e('Team Lead', 'kelbe-project-tracker'); ?></option>
                                <option value="contractor"><?php _e('Contractor', 'kelbe-project-tracker'); ?></option>
                            </select>
                        </td>
                    </tr>
                </table>
                
                <?php submit_button(__('Assign Users', 'kelbe-project-tracker')); ?>
            </form>
        </div>
        
        <p>
            <a href="<?php echo esc_url(admin_url('users.php?page=kpt-user-management')); ?>">
                ← <?php _e('Back to User List', 'kelbe-project-tracker'); ?>
            </a>
        </p>
        <?php
    }
    
    /**
     * Render capabilities management form
     */
    private function render_capabilities_form() {
        $settings = get_option('kpt_settings', array());
        $permissions = isset($settings['permissions']) ? $settings['permissions'] : array();
        
        $roles = array(
            'administrator' => __('Administrator', 'kelbe-project-tracker'),
            'project_manager' => __('Project Manager', 'kelbe-project-tracker'),
            'contractor' => __('Contractor', 'kelbe-project-tracker'),
            'client' => __('Client', 'kelbe-project-tracker')
        );
        
        $capabilities = array(
            'view_projects' => __('View Projects', 'kelbe-project-tracker'),
            'edit_projects' => __('Edit Projects', 'kelbe-project-tracker'),
            'delete_projects' => __('Delete Projects', 'kelbe-project-tracker'),
            'manage_bids' => __('Manage Bids', 'kelbe-project-tracker'),
            'view_budget' => __('View Budget', 'kelbe-project-tracker'),
            'edit_budget' => __('Edit Budget', 'kelbe-project-tracker'),
            'view_proposals' => __('View Proposals', 'kelbe-project-tracker'),
            'create_proposals' => __('Create Proposals', 'kelbe-project-tracker'),
            'manage_leads' => __('Manage Leads', 'kelbe-project-tracker'),
            'manage_team' => __('Manage Team', 'kelbe-project-tracker')
        );
        
        ?>
        <div class="kpt-capabilities-form">
            <h2><?php _e('Manage User Capabilities', 'kelbe-project-tracker'); ?></h2>
            <p><?php _e('Configure which capabilities each role should have.', 'kelbe-project-tracker'); ?></p>
            
            <form method="post" id="kpt-capabilities-form">
                <?php wp_nonce_field('kpt_capabilities', 'kpt_capabilities_nonce'); ?>
                
                <table class="wp-list-table widefat fixed striped">
                    <thead>
                        <tr>
                            <th><?php _e('Capability', 'kelbe-project-tracker'); ?></th>
                            <?php foreach ($roles as $role_id => $role_name): ?>
                                <th><?php echo esc_html($role_name); ?></th>
                            <?php endforeach; ?>
                        </tr>
                    </thead>
                    <tbody>
                        <?php foreach ($capabilities as $cap_id => $cap_name): ?>
                            <tr>
                                <td><strong><?php echo esc_html($cap_name); ?></strong></td>
                                <?php foreach ($roles as $role_id => $role_name): ?>
                                    <td>
                                        <input type="checkbox" 
                                               name="capabilities[<?php echo esc_attr($role_id); ?>][<?php echo esc_attr($cap_id); ?>]" 
                                               value="1" 
                                               <?php checked(isset($permissions[$role_id][$cap_id]) && $permissions[$role_id][$cap_id], true); ?>>
                                    </td>
                                <?php endforeach; ?>
                            </tr>
                        <?php endforeach; ?>
                    </tbody>
                </table>
                
                <?php submit_button(__('Update Capabilities', 'kelbe-project-tracker')); ?>
            </form>
        </div>
        
        <p>
            <a href="<?php echo esc_url(admin_url('users.php?page=kpt-user-management')); ?>">
                ← <?php _e('Back to User List', 'kelbe-project-tracker'); ?>
            </a>
        </p>
        <?php
    }
    
    /**
     * Enqueue admin scripts
     *
     * @param string $hook Current admin page hook
     */
    public function enqueue_scripts($hook) {
        if ('users_page_kpt-user-management' !== $hook) {
            return;
        }
        
        wp_enqueue_script(
            'kpt-admin-users',
            KPT_PLUGIN_URL . 'assets/js/admin-users.js',
            array('jquery'),
            KPT_VERSION,
            true
        );
        
        wp_localize_script('kpt-admin-users', 'kptUsers', array(
            'ajax_url' => admin_url('admin-ajax.php'),
            'nonce' => wp_create_nonce('kpt_users_nonce')
        ));
    }
    
    /**
     * Add custom user columns
     *
     * @param array $columns Existing columns
     * @return array
     */
    public function add_user_columns($columns) {
        $columns['kpt_portal_role'] = __('Portal Role', 'kelbe-project-tracker');
        $columns['kpt_trade_type'] = __('Trade Type', 'kelbe-project-tracker');
        return $columns;
    }
    
    /**
     * Render custom user column
     *
     * @param string $output Column output
     * @param string $column_name Column name
     * @param int $user_id User ID
     * @return string
     */
    public function render_user_column($output, $column_name, $user_id) {
        switch ($column_name) {
            case 'kpt_portal_role':
                $portal_role = get_user_meta($user_id, 'kpt_portal_role', true);
                return $this->get_portal_role_label($portal_role);
                
            case 'kpt_trade_type':
                $trade_type = get_user_meta($user_id, 'kpt_trade_type', true);
                return $this->get_trade_type_label($trade_type);
        }
        
        return $output;
    }
    
    /**
     * AJAX bulk assign users
     */
    public function ajax_bulk_assign_users() {
        check_ajax_referer('kpt_bulk_assign', 'nonce');
        
        if (!current_user_can('manage_options')) {
            wp_send_json_error(array('message' => __('Permission denied', 'kelbe-project-tracker')));
        }
        
        $users = isset($_POST['users']) ? array_map('absint', $_POST['users']) : array();
        $projects = isset($_POST['projects']) ? array_map('absint', $_POST['projects']) : array();
        $role = isset($_POST['role']) ? sanitize_text_field($_POST['role']) : 'member';
        
        if (empty($users) || empty($projects)) {
            wp_send_json_error(array('message' => __('Please select users and projects', 'kelbe-project-tracker')));
        }
        
        global $wpdb;
        $table_name = $wpdb->prefix . 'kpt_team_members';
        $assigned_count = 0;
        
        foreach ($projects as $project_id) {
            foreach ($users as $user_id) {
                // Check if already assigned
                $exists = $wpdb->get_var($wpdb->prepare(
                    "SELECT id FROM $table_name WHERE project_id = %d AND user_id = %d",
                    $project_id,
                    $user_id
                ));
                
                if (!$exists) {
                    $wpdb->insert(
                        $table_name,
                        array(
                            'project_id' => $project_id,
                            'user_id' => $user_id,
                            'role' => $role,
                            'added_by' => get_current_user_id(),
                            'added_at' => current_time('mysql')
                        ),
                        array('%d', '%d', '%s', '%d', '%s')
                    );
                    $assigned_count++;
                }
            }
        }
        
        wp_send_json_success(array(
            'message' => sprintf(
                __('%d user assignments created successfully', 'kelbe-project-tracker'),
                $assigned_count
            )
        ));
    }
    
    /**
     * AJAX update user capabilities
     */
    public function ajax_update_user_capabilities() {
        check_ajax_referer('kpt_capabilities', 'nonce');
        
        if (!current_user_can('manage_options')) {
            wp_send_json_error(array('message' => __('Permission denied', 'kelbe-project-tracker')));
        }
        
        $capabilities = isset($_POST['capabilities']) ? $_POST['capabilities'] : array();
        
        $settings = get_option('kpt_settings', array());
        $settings['permissions'] = array();
        
        foreach ($capabilities as $role => $caps) {
            foreach ($caps as $cap => $value) {
                $settings['permissions'][$role][$cap] = (bool) $value;
            }
        }
        
        update_option('kpt_settings', $settings);
        
        wp_send_json_success(array('message' => __('Capabilities updated successfully', 'kelbe-project-tracker')));
    }
    
    /**
     * Get user project count
     *
     * @param int $user_id User ID
     * @return int
     */
    private function get_user_project_count($user_id) {
        global $wpdb;
        
        $table_name = $wpdb->prefix . 'kpt_team_members';
        
        return (int) $wpdb->get_var($wpdb->prepare(
            "SELECT COUNT(DISTINCT project_id) FROM $table_name WHERE user_id = %d",
            $user_id
        ));
    }
    
    /**
     * Get portal role label
     *
     * @param string $role_id Role ID
     * @return string
     */
    private function get_portal_role_label($role_id) {
        $labels = array(
            'administrator' => __('Administrator', 'kelbe-project-tracker'),
            'project_manager' => __('Project Manager', 'kelbe-project-tracker'),
            'contractor' => __('Contractor', 'kelbe-project-tracker'),
            'client' => __('Client', 'kelbe-project-tracker')
        );
        
        return isset($labels[$role_id]) ? $labels[$role_id] : '-';
    }
    
    /**
     * Get trade type label
     *
     * @param string $trade_type_id Trade type ID
     * @return string
     */
    private function get_trade_type_label($trade_type_id) {
        if (empty($trade_type_id)) {
            return '-';
        }
        
        $settings = get_option('kpt_settings', array());
        $trade_types = isset($settings['trade_types']) ? $settings['trade_types'] : array();
        
        return isset($trade_types[$trade_type_id]['name']) ? $trade_types[$trade_type_id]['name'] : '-';
    }
}

// Initialize
KPT_Admin_Users::get_instance();
