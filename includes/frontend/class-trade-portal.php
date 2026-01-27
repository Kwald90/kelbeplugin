<?php
/**
 * Trade Portal Frontend Class
 *
 * Handles all frontend portal views for team members, trades, and project managers
 *
 * @package Kelbe_Project_Tracker
 */

// Exit if accessed directly
if (!defined('ABSPATH')) {
    exit;
}

/**
 * Trade Portal class
 */
class KPT_Trade_Portal {
    
    /**
     * Single instance
     *
     * @var KPT_Trade_Portal
     */
    private static $instance = null;
    
    /**
     * Current user ID
     *
     * @var int
     */
    private $current_user_id;
    
    /**
     * Current view
     *
     * @var string
     */
    private $current_view;
    
    /**
     * User role in system
     *
     * @var string
     */
    private $user_role;
    
    /**
     * Get instance
     *
     * @return KPT_Trade_Portal
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
        $this->current_user_id = get_current_user_id();
        $this->current_view = $this->get_current_view();
        $this->user_role = $this->get_user_role();
        
        add_action('init', array($this, 'handle_form_submissions'));
        add_shortcode('kpt_trade_portal', array($this, 'render_portal'));
    }
    
    /**
     * Get current view from URL parameter
     *
     * @return string
     */
    private function get_current_view() {
        return isset($_GET['view']) ? sanitize_text_field($_GET['view']) : 'home';
    }
    
    /**
     * Get user role in the system
     *
     * @return string
     */
    private function get_user_role() {
        if (!$this->current_user_id) {
            return '';
        }
        
        $role = get_user_meta($this->current_user_id, 'kpt_portal_role', true);
        
        // Fallback to checking WordPress roles
        if (empty($role)) {
            $user = wp_get_current_user();
            if (in_array('administrator', $user->roles)) {
                $role = 'administrator';
            } elseif (in_array('editor', $user->roles)) {
                $role = 'project_manager';
            }
        }
        
        return $role;
    }
    
    /**
     * Check if user has access to the portal
     *
     * @return bool
     */
    private function has_portal_access() {
        if (!$this->current_user_id) {
            return false;
        }
        
        $allowed_roles = array('administrator', 'project_manager', 'contractor', 'construction_manager');
        return in_array($this->user_role, $allowed_roles);
    }
    
    /**
     * Check if user is PM or admin
     *
     * @return bool
     */
    private function is_pm() {
        return in_array($this->user_role, array('administrator', 'project_manager'));
    }
    
    /**
     * Get projects for current user
     *
     * @return array
     */
    private function get_user_projects() {
        global $wpdb;
        
        // PMs get all projects
        if ($this->is_pm()) {
            $args = array(
                'post_type' => 'kpt_project',
                'post_status' => 'publish',
                'posts_per_page' => -1,
                'orderby' => 'date',
                'order' => 'DESC',
            );
            return get_posts($args);
        }
        
        // Trades only get assigned projects
        $table = $wpdb->prefix . 'kpt_team_members';
        $project_ids = $wpdb->get_col($wpdb->prepare(
            "SELECT DISTINCT project_id FROM $table WHERE user_id = %d",
            $this->current_user_id
        ));
        
        if (empty($project_ids)) {
            return array();
        }
        
        $args = array(
            'post_type' => 'kpt_project',
            'post_status' => 'publish',
            'post__in' => $project_ids,
            'posts_per_page' => -1,
            'orderby' => 'date',
            'order' => 'DESC',
        );
        
        return get_posts($args);
    }
    
    /**
     * Get single project with access check
     *
     * @param int $project_id
     * @return WP_Post|null
     */
    private function get_project_with_access($project_id) {
        global $wpdb;
        
        $project = get_post($project_id);
        
        if (!$project || $project->post_type !== 'kpt_project') {
            return null;
        }
        
        // PMs have access to all projects
        if ($this->is_pm()) {
            return $project;
        }
        
        // Check if trade is assigned to this project
        $table = $wpdb->prefix . 'kpt_team_members';
        $member = $wpdb->get_row($wpdb->prepare(
            "SELECT * FROM $table WHERE project_id = %d AND user_id = %d",
            $project_id,
            $this->current_user_id
        ));
        
        return $member ? $project : null;
    }
    
    /**
     * Handle form submissions
     */
    public function handle_form_submissions() {
        if (!isset($_POST['kpt_action']) || !$this->current_user_id) {
            return;
        }
        
        // Verify nonce
        if (!isset($_POST['kpt_nonce']) || !wp_verify_nonce($_POST['kpt_nonce'], 'kpt_portal_action')) {
            wp_die(__('Security check failed', 'kelbe-project-tracker'));
        }
        
        $action = sanitize_text_field($_POST['kpt_action']);
        
        switch ($action) {
            case 'create_project':
                $this->handle_create_project();
                break;
            case 'update_project':
                $this->handle_update_project();
                break;
        }
    }
    
    /**
     * Handle create project form submission
     */
    private function handle_create_project() {
        if (!$this->is_pm()) {
            wp_die(__('Unauthorized', 'kelbe-project-tracker'));
        }
        
        $project_data = array(
            'post_title' => sanitize_text_field($_POST['project_title']),
            'post_type' => 'kpt_project',
            'post_status' => 'publish',
        );
        
        $project_id = wp_insert_post($project_data);
        
        if ($project_id) {
            // Save meta data
            if (isset($_POST['customer_name'])) {
                update_post_meta($project_id, '_kpt_customer_name', sanitize_text_field($_POST['customer_name']));
            }
            if (isset($_POST['customer_email'])) {
                update_post_meta($project_id, '_kpt_customer_email', sanitize_email($_POST['customer_email']));
            }
            if (isset($_POST['customer_phone'])) {
                update_post_meta($project_id, '_kpt_customer_phone', sanitize_text_field($_POST['customer_phone']));
            }
            if (isset($_POST['project_address'])) {
                update_post_meta($project_id, '_kpt_project_address', sanitize_text_field($_POST['project_address']));
            }
            if (isset($_POST['project_city'])) {
                update_post_meta($project_id, '_kpt_project_city', sanitize_text_field($_POST['project_city']));
            }
            if (isset($_POST['project_status'])) {
                update_post_meta($project_id, '_kpt_project_status', sanitize_text_field($_POST['project_status']));
            }
            if (isset($_POST['project_stage'])) {
                update_post_meta($project_id, '_kpt_project_stage', absint($_POST['project_stage']));
            }
            
            wp_redirect(add_query_arg(array('view' => 'job', 'id' => $project_id), get_permalink()));
            exit;
        }
    }
    
    /**
     * Handle update project form submission
     */
    private function handle_update_project() {
        if (!$this->is_pm()) {
            wp_die(__('Unauthorized', 'kelbe-project-tracker'));
        }
        
        $project_id = absint($_POST['project_id']);
        
        $project_data = array(
            'ID' => $project_id,
            'post_title' => sanitize_text_field($_POST['project_title']),
        );
        
        wp_update_post($project_data);
        
        // Update meta data
        if (isset($_POST['customer_name'])) {
            update_post_meta($project_id, '_kpt_customer_name', sanitize_text_field($_POST['customer_name']));
        }
        if (isset($_POST['customer_email'])) {
            update_post_meta($project_id, '_kpt_customer_email', sanitize_email($_POST['customer_email']));
        }
        if (isset($_POST['customer_phone'])) {
            update_post_meta($project_id, '_kpt_customer_phone', sanitize_text_field($_POST['customer_phone']));
        }
        if (isset($_POST['project_address'])) {
            update_post_meta($project_id, '_kpt_project_address', sanitize_text_field($_POST['project_address']));
        }
        if (isset($_POST['project_city'])) {
            update_post_meta($project_id, '_kpt_project_city', sanitize_text_field($_POST['project_city']));
        }
        if (isset($_POST['project_status'])) {
            update_post_meta($project_id, '_kpt_project_status', sanitize_text_field($_POST['project_status']));
        }
        if (isset($_POST['project_stage'])) {
            update_post_meta($project_id, '_kpt_project_stage', absint($_POST['project_stage']));
        }
        
        wp_redirect(add_query_arg(array('view' => 'job', 'id' => $project_id), get_permalink()));
        exit;
    }
    
    /**
     * Main render method for shortcode
     *
     * @return string
     */
    public function render_portal() {
        if (!$this->current_user_id) {
            return $this->render_login_required();
        }
        
        if (!$this->has_portal_access()) {
            return $this->render_unauthorized();
        }
        
        ob_start();
        
        echo '<div class="kpt-portal">';
        $this->render_header();
        $this->render_navigation();
        
        echo '<div class="kpt-portal__content">';
        
        switch ($this->current_view) {
            case 'home':
                $this->render_home();
                break;
            case 'all-projects':
                $this->render_all_projects();
                break;
            case 'job':
                $this->render_job();
                break;
            case 'new-project':
                $this->render_new_project();
                break;
            case 'edit-project':
                $this->render_edit_project();
                break;
            case 'team':
                $this->render_team();
                break;
            case 'bids':
                $this->render_bids();
                break;
            case 'budget':
                $this->render_budget();
                break;
            case 'leads':
                $this->render_leads();
                break;
            case 'checklist':
                $this->render_checklist();
                break;
            case 'files':
                $this->render_files();
                break;
            case 'change_orders':
                $this->render_change_orders();
                break;
            case 'calendar':
                $this->render_calendar();
                break;
            default:
                $this->render_home();
        }
        
        echo '</div>'; // .kpt-portal__content
        echo '</div>'; // .kpt-portal
        
        return ob_get_clean();
    }
    
    /**
     * Render login required message
     *
     * @return string
     */
    private function render_login_required() {
        ob_start();
        ?>
        <div class="kpt-portal__login-required">
            <div class="kpt-message kpt-message--warning">
                <p><?php _e('Please log in to access the portal.', 'kelbe-project-tracker'); ?></p>
                <p><a href="<?php echo esc_url(wp_login_url(get_permalink())); ?>" class="kpt-button kpt-button--primary">
                    <?php _e('Log In', 'kelbe-project-tracker'); ?>
                </a></p>
            </div>
        </div>
        <?php
        return ob_get_clean();
    }
    
    /**
     * Render unauthorized message
     *
     * @return string
     */
    private function render_unauthorized() {
        ob_start();
        ?>
        <div class="kpt-portal__unauthorized">
            <div class="kpt-message kpt-message--error">
                <h2><?php _e('Access Denied', 'kelbe-project-tracker'); ?></h2>
                <p><?php _e('You do not have permission to access this portal.', 'kelbe-project-tracker'); ?></p>
            </div>
        </div>
        <?php
        return ob_get_clean();
    }
    
    /**
     * Render portal header
     */
    private function render_header() {
        $user = wp_get_current_user();
        ?>
        <div class="kpt-portal__header">
            <div class="kpt-portal__header-left">
                <h1 class="kpt-portal__title"><?php _e('Project Portal', 'kelbe-project-tracker'); ?></h1>
            </div>
            <div class="kpt-portal__header-right">
                <div class="kpt-portal__user">
                    <span class="kpt-portal__user-avatar">
                        <?php echo get_avatar($this->current_user_id, 32); ?>
                    </span>
                    <span class="kpt-portal__user-name"><?php echo esc_html($user->display_name); ?></span>
                    <span class="kpt-portal__user-role">(<?php echo esc_html($this->user_role); ?>)</span>
                </div>
            </div>
        </div>
        <?php
    }
    
    /**
     * Render portal navigation
     */
    private function render_navigation() {
        $base_url = get_permalink();
        $nav_items = array();
        
        // All users get home and projects
        $nav_items['home'] = __('Dashboard', 'kelbe-project-tracker');
        $nav_items['all-projects'] = __('All Projects', 'kelbe-project-tracker');
        
        // PM-only items
        if ($this->is_pm()) {
            $nav_items['new-project'] = __('New Project', 'kelbe-project-tracker');
            $nav_items['team'] = __('Team', 'kelbe-project-tracker');
            $nav_items['bids'] = __('Bids', 'kelbe-project-tracker');
            $nav_items['budget'] = __('Budget', 'kelbe-project-tracker');
            $nav_items['leads'] = __('Leads', 'kelbe-project-tracker');
        }
        
        // All users get these
        $nav_items['calendar'] = __('Calendar', 'kelbe-project-tracker');
        
        ?>
        <nav class="kpt-portal__nav">
            <ul class="kpt-portal__nav-list">
                <?php foreach ($nav_items as $view => $label): ?>
                    <li class="kpt-portal__nav-item <?php echo $this->current_view === $view ? 'kpt-portal__nav-item--active' : ''; ?>">
                        <a href="<?php echo esc_url(add_query_arg('view', $view, $base_url)); ?>" class="kpt-portal__nav-link">
                            <?php echo esc_html($label); ?>
                        </a>
                    </li>
                <?php endforeach; ?>
            </ul>
        </nav>
        <?php
    }
    
    /**
     * Render home/dashboard view
     */
    private function render_home() {
        $projects = $this->get_user_projects();
        $total_projects = count($projects);
        
        // Calculate stats
        $active_projects = 0;
        $completed_projects = 0;
        foreach ($projects as $project) {
            $status = get_post_meta($project->ID, '_kpt_project_status', true);
            if ($status === 'completed') {
                $completed_projects++;
            } elseif (in_array($status, array('in_progress', 'on_hold'))) {
                $active_projects++;
            }
        }
        
        ?>
        <div class="kpt-portal__home">
            <h2 class="kpt-portal__page-title"><?php _e('Dashboard', 'kelbe-project-tracker'); ?></h2>
            
            <div class="kpt-portal__stats">
                <div class="kpt-stat-card">
                    <div class="kpt-stat-card__value"><?php echo esc_html($total_projects); ?></div>
                    <div class="kpt-stat-card__label"><?php _e('Total Projects', 'kelbe-project-tracker'); ?></div>
                </div>
                <div class="kpt-stat-card">
                    <div class="kpt-stat-card__value"><?php echo esc_html($active_projects); ?></div>
                    <div class="kpt-stat-card__label"><?php _e('Active Projects', 'kelbe-project-tracker'); ?></div>
                </div>
                <div class="kpt-stat-card">
                    <div class="kpt-stat-card__value"><?php echo esc_html($completed_projects); ?></div>
                    <div class="kpt-stat-card__label"><?php _e('Completed', 'kelbe-project-tracker'); ?></div>
                </div>
            </div>
            
            <h3 class="kpt-portal__section-title"><?php _e('Recent Projects', 'kelbe-project-tracker'); ?></h3>
            
            <div class="kpt-portal__projects-grid">
                <?php
                $recent_projects = array_slice($projects, 0, 6);
                if (empty($recent_projects)):
                ?>
                    <p class="kpt-portal__no-projects"><?php _e('No projects found.', 'kelbe-project-tracker'); ?></p>
                <?php else: ?>
                    <?php foreach ($recent_projects as $project): ?>
                        <?php $this->render_project_card($project); ?>
                    <?php endforeach; ?>
                <?php endif; ?>
            </div>
        </div>
        <?php
    }
    
    /**
     * Render all projects view
     */
    private function render_all_projects() {
        $projects = $this->get_user_projects();
        ?>
        <div class="kpt-portal__all-projects">
            <div class="kpt-portal__page-header">
                <h2 class="kpt-portal__page-title"><?php _e('All Projects', 'kelbe-project-tracker'); ?></h2>
                <?php if ($this->is_pm()): ?>
                    <a href="<?php echo esc_url(add_query_arg('view', 'new-project', get_permalink())); ?>" class="kpt-button kpt-button--primary">
                        <?php _e('+ New Project', 'kelbe-project-tracker'); ?>
                    </a>
                <?php endif; ?>
            </div>
            
            <div class="kpt-portal__projects-grid">
                <?php if (empty($projects)): ?>
                    <p class="kpt-portal__no-projects"><?php _e('No projects found.', 'kelbe-project-tracker'); ?></p>
                <?php else: ?>
                    <?php foreach ($projects as $project): ?>
                        <?php $this->render_project_card($project); ?>
                    <?php endforeach; ?>
                <?php endif; ?>
            </div>
        </div>
        <?php
    }
    
    /**
     * Render single project/job view
     */
    private function render_job() {
        if (!isset($_GET['id'])) {
            echo '<p>' . __('Project ID is required.', 'kelbe-project-tracker') . '</p>';
            return;
        }
        
        $project_id = absint($_GET['id']);
        $project = $this->get_project_with_access($project_id);
        
        if (!$project) {
            echo '<p>' . __('Project not found or access denied.', 'kelbe-project-tracker') . '</p>';
            return;
        }
        
        $tab = isset($_GET['tab']) ? sanitize_text_field($_GET['tab']) : 'details';
        $base_url = add_query_arg(array('view' => 'job', 'id' => $project_id), get_permalink());
        
        $customer_name = get_post_meta($project_id, '_kpt_customer_name', true);
        $project_address = get_post_meta($project_id, '_kpt_project_address', true);
        $project_status = get_post_meta($project_id, '_kpt_project_status', true);
        
        ?>
        <div class="kpt-portal__job">
            <div class="kpt-portal__page-header">
                <div>
                    <h2 class="kpt-portal__page-title"><?php echo esc_html($project->post_title); ?></h2>
                    <?php if ($customer_name): ?>
                        <p class="kpt-portal__job-customer"><?php echo esc_html($customer_name); ?></p>
                    <?php endif; ?>
                    <?php if ($project_address): ?>
                        <p class="kpt-portal__job-address"><?php echo esc_html($project_address); ?></p>
                    <?php endif; ?>
                </div>
                <?php if ($this->is_pm()): ?>
                    <a href="<?php echo esc_url(add_query_arg(array('view' => 'edit-project', 'id' => $project_id), get_permalink())); ?>" class="kpt-button kpt-button--secondary">
                        <?php _e('Edit Project', 'kelbe-project-tracker'); ?>
                    </a>
                <?php endif; ?>
            </div>
            
            <?php if ($project_status): ?>
                <div class="kpt-portal__job-status">
                    <span class="kpt-badge kpt-badge--<?php echo esc_attr($project_status); ?>">
                        <?php echo esc_html(ucfirst(str_replace('_', ' ', $project_status))); ?>
                    </span>
                </div>
            <?php endif; ?>
            
            <div class="kpt-portal__tabs">
                <nav class="kpt-portal__tabs-nav">
                    <a href="<?php echo esc_url(add_query_arg('tab', 'details', $base_url)); ?>" class="kpt-portal__tab <?php echo $tab === 'details' ? 'kpt-portal__tab--active' : ''; ?>">
                        <?php _e('Details', 'kelbe-project-tracker'); ?>
                    </a>
                    <a href="<?php echo esc_url(add_query_arg('tab', 'checklist', $base_url)); ?>" class="kpt-portal__tab <?php echo $tab === 'checklist' ? 'kpt-portal__tab--active' : ''; ?>">
                        <?php _e('Checklist', 'kelbe-project-tracker'); ?>
                    </a>
                    <a href="<?php echo esc_url(add_query_arg('tab', 'files', $base_url)); ?>" class="kpt-portal__tab <?php echo $tab === 'files' ? 'kpt-portal__tab--active' : ''; ?>">
                        <?php _e('Files', 'kelbe-project-tracker'); ?>
                    </a>
                    <a href="<?php echo esc_url(add_query_arg('tab', 'bids', $base_url)); ?>" class="kpt-portal__tab <?php echo $tab === 'bids' ? 'kpt-portal__tab--active' : ''; ?>">
                        <?php _e('Bids', 'kelbe-project-tracker'); ?>
                    </a>
                    <a href="<?php echo esc_url(add_query_arg('tab', 'change_orders', $base_url)); ?>" class="kpt-portal__tab <?php echo $tab === 'change_orders' ? 'kpt-portal__tab--active' : ''; ?>">
                        <?php _e('Change Orders', 'kelbe-project-tracker'); ?>
                    </a>
                </nav>
                
                <div class="kpt-portal__tabs-content">
                    <?php
                    switch ($tab) {
                        case 'details':
                            $this->render_job_details($project);
                            break;
                        case 'checklist':
                            $this->render_job_checklist($project);
                            break;
                        case 'files':
                            $this->render_job_files($project);
                            break;
                        case 'bids':
                            $this->render_job_bids($project);
                            break;
                        case 'change_orders':
                            $this->render_job_change_orders($project);
                            break;
                        default:
                            $this->render_job_details($project);
                    }
                    ?>
                </div>
            </div>
        </div>
        <?php
    }
    
    /**
     * Render new project form
     */
    private function render_new_project() {
        if (!$this->is_pm()) {
            echo '<p>' . __('Access denied.', 'kelbe-project-tracker') . '</p>';
            return;
        }
        
        ?>
        <div class="kpt-portal__new-project">
            <h2 class="kpt-portal__page-title"><?php _e('Create New Project', 'kelbe-project-tracker'); ?></h2>
            
            <form method="post" class="kpt-form">
                <?php wp_nonce_field('kpt_portal_action', 'kpt_nonce'); ?>
                <input type="hidden" name="kpt_action" value="create_project">
                
                <div class="kpt-form__section">
                    <h3 class="kpt-form__section-title"><?php _e('Project Information', 'kelbe-project-tracker'); ?></h3>
                    
                    <div class="kpt-form__field">
                        <label for="project_title" class="kpt-form__label"><?php _e('Project Name', 'kelbe-project-tracker'); ?></label>
                        <input type="text" id="project_title" name="project_title" class="kpt-form__input" required>
                    </div>
                    
                    <div class="kpt-form__field">
                        <label for="project_address" class="kpt-form__label"><?php _e('Address', 'kelbe-project-tracker'); ?></label>
                        <input type="text" id="project_address" name="project_address" class="kpt-form__input">
                    </div>
                    
                    <div class="kpt-form__field">
                        <label for="project_city" class="kpt-form__label"><?php _e('City', 'kelbe-project-tracker'); ?></label>
                        <input type="text" id="project_city" name="project_city" class="kpt-form__input">
                    </div>
                    
                    <div class="kpt-form__field">
                        <label for="project_status" class="kpt-form__label"><?php _e('Status', 'kelbe-project-tracker'); ?></label>
                        <select id="project_status" name="project_status" class="kpt-form__select">
                            <option value="planning"><?php _e('Planning', 'kelbe-project-tracker'); ?></option>
                            <option value="in_progress"><?php _e('In Progress', 'kelbe-project-tracker'); ?></option>
                            <option value="on_hold"><?php _e('On Hold', 'kelbe-project-tracker'); ?></option>
                            <option value="completed"><?php _e('Completed', 'kelbe-project-tracker'); ?></option>
                        </select>
                    </div>
                    
                    <div class="kpt-form__field">
                        <label for="project_stage" class="kpt-form__label"><?php _e('Stage', 'kelbe-project-tracker'); ?></label>
                        <select id="project_stage" name="project_stage" class="kpt-form__select">
                            <option value="1"><?php _e('Stage 1', 'kelbe-project-tracker'); ?></option>
                            <option value="2"><?php _e('Stage 2', 'kelbe-project-tracker'); ?></option>
                            <option value="3"><?php _e('Stage 3', 'kelbe-project-tracker'); ?></option>
                            <option value="4"><?php _e('Stage 4', 'kelbe-project-tracker'); ?></option>
                            <option value="5"><?php _e('Stage 5', 'kelbe-project-tracker'); ?></option>
                        </select>
                    </div>
                </div>
                
                <div class="kpt-form__section">
                    <h3 class="kpt-form__section-title"><?php _e('Customer Information', 'kelbe-project-tracker'); ?></h3>
                    
                    <div class="kpt-form__field">
                        <label for="customer_name" class="kpt-form__label"><?php _e('Customer Name', 'kelbe-project-tracker'); ?></label>
                        <input type="text" id="customer_name" name="customer_name" class="kpt-form__input">
                    </div>
                    
                    <div class="kpt-form__field">
                        <label for="customer_email" class="kpt-form__label"><?php _e('Email', 'kelbe-project-tracker'); ?></label>
                        <input type="email" id="customer_email" name="customer_email" class="kpt-form__input">
                    </div>
                    
                    <div class="kpt-form__field">
                        <label for="customer_phone" class="kpt-form__label"><?php _e('Phone', 'kelbe-project-tracker'); ?></label>
                        <input type="tel" id="customer_phone" name="customer_phone" class="kpt-form__input">
                    </div>
                </div>
                
                <div class="kpt-form__actions">
                    <button type="submit" class="kpt-button kpt-button--primary"><?php _e('Create Project', 'kelbe-project-tracker'); ?></button>
                    <a href="<?php echo esc_url(add_query_arg('view', 'all-projects', get_permalink())); ?>" class="kpt-button kpt-button--secondary"><?php _e('Cancel', 'kelbe-project-tracker'); ?></a>
                </div>
            </form>
        </div>
        <?php
    }
    
    /**
     * Render edit project form
     */
    private function render_edit_project() {
        if (!$this->is_pm()) {
            echo '<p>' . __('Access denied.', 'kelbe-project-tracker') . '</p>';
            return;
        }
        
        if (!isset($_GET['id'])) {
            echo '<p>' . __('Project ID is required.', 'kelbe-project-tracker') . '</p>';
            return;
        }
        
        $project_id = absint($_GET['id']);
        $project = get_post($project_id);
        
        if (!$project || $project->post_type !== 'kpt_project') {
            echo '<p>' . __('Project not found.', 'kelbe-project-tracker') . '</p>';
            return;
        }
        
        $customer_name = get_post_meta($project_id, '_kpt_customer_name', true);
        $customer_email = get_post_meta($project_id, '_kpt_customer_email', true);
        $customer_phone = get_post_meta($project_id, '_kpt_customer_phone', true);
        $project_address = get_post_meta($project_id, '_kpt_project_address', true);
        $project_city = get_post_meta($project_id, '_kpt_project_city', true);
        $project_status = get_post_meta($project_id, '_kpt_project_status', true);
        $project_stage = get_post_meta($project_id, '_kpt_project_stage', true);
        
        ?>
        <div class="kpt-portal__edit-project">
            <h2 class="kpt-portal__page-title"><?php _e('Edit Project', 'kelbe-project-tracker'); ?></h2>
            
            <form method="post" class="kpt-form">
                <?php wp_nonce_field('kpt_portal_action', 'kpt_nonce'); ?>
                <input type="hidden" name="kpt_action" value="update_project">
                <input type="hidden" name="project_id" value="<?php echo esc_attr($project_id); ?>">
                
                <div class="kpt-form__section">
                    <h3 class="kpt-form__section-title"><?php _e('Project Information', 'kelbe-project-tracker'); ?></h3>
                    
                    <div class="kpt-form__field">
                        <label for="project_title" class="kpt-form__label"><?php _e('Project Name', 'kelbe-project-tracker'); ?></label>
                        <input type="text" id="project_title" name="project_title" class="kpt-form__input" value="<?php echo esc_attr($project->post_title); ?>" required>
                    </div>
                    
                    <div class="kpt-form__field">
                        <label for="project_address" class="kpt-form__label"><?php _e('Address', 'kelbe-project-tracker'); ?></label>
                        <input type="text" id="project_address" name="project_address" class="kpt-form__input" value="<?php echo esc_attr($project_address); ?>">
                    </div>
                    
                    <div class="kpt-form__field">
                        <label for="project_city" class="kpt-form__label"><?php _e('City', 'kelbe-project-tracker'); ?></label>
                        <input type="text" id="project_city" name="project_city" class="kpt-form__input" value="<?php echo esc_attr($project_city); ?>">
                    </div>
                    
                    <div class="kpt-form__field">
                        <label for="project_status" class="kpt-form__label"><?php _e('Status', 'kelbe-project-tracker'); ?></label>
                        <select id="project_status" name="project_status" class="kpt-form__select">
                            <option value="planning" <?php selected($project_status, 'planning'); ?>><?php _e('Planning', 'kelbe-project-tracker'); ?></option>
                            <option value="in_progress" <?php selected($project_status, 'in_progress'); ?>><?php _e('In Progress', 'kelbe-project-tracker'); ?></option>
                            <option value="on_hold" <?php selected($project_status, 'on_hold'); ?>><?php _e('On Hold', 'kelbe-project-tracker'); ?></option>
                            <option value="completed" <?php selected($project_status, 'completed'); ?>><?php _e('Completed', 'kelbe-project-tracker'); ?></option>
                        </select>
                    </div>
                    
                    <div class="kpt-form__field">
                        <label for="project_stage" class="kpt-form__label"><?php _e('Stage', 'kelbe-project-tracker'); ?></label>
                        <select id="project_stage" name="project_stage" class="kpt-form__select">
                            <option value="1" <?php selected($project_stage, 1); ?>><?php _e('Stage 1', 'kelbe-project-tracker'); ?></option>
                            <option value="2" <?php selected($project_stage, 2); ?>><?php _e('Stage 2', 'kelbe-project-tracker'); ?></option>
                            <option value="3" <?php selected($project_stage, 3); ?>><?php _e('Stage 3', 'kelbe-project-tracker'); ?></option>
                            <option value="4" <?php selected($project_stage, 4); ?>><?php _e('Stage 4', 'kelbe-project-tracker'); ?></option>
                            <option value="5" <?php selected($project_stage, 5); ?>><?php _e('Stage 5', 'kelbe-project-tracker'); ?></option>
                        </select>
                    </div>
                </div>
                
                <div class="kpt-form__section">
                    <h3 class="kpt-form__section-title"><?php _e('Customer Information', 'kelbe-project-tracker'); ?></h3>
                    
                    <div class="kpt-form__field">
                        <label for="customer_name" class="kpt-form__label"><?php _e('Customer Name', 'kelbe-project-tracker'); ?></label>
                        <input type="text" id="customer_name" name="customer_name" class="kpt-form__input" value="<?php echo esc_attr($customer_name); ?>">
                    </div>
                    
                    <div class="kpt-form__field">
                        <label for="customer_email" class="kpt-form__label"><?php _e('Email', 'kelbe-project-tracker'); ?></label>
                        <input type="email" id="customer_email" name="customer_email" class="kpt-form__input" value="<?php echo esc_attr($customer_email); ?>">
                    </div>
                    
                    <div class="kpt-form__field">
                        <label for="customer_phone" class="kpt-form__label"><?php _e('Phone', 'kelbe-project-tracker'); ?></label>
                        <input type="tel" id="customer_phone" name="customer_phone" class="kpt-form__input" value="<?php echo esc_attr($customer_phone); ?>">
                    </div>
                </div>
                
                <div class="kpt-form__actions">
                    <button type="submit" class="kpt-button kpt-button--primary"><?php _e('Update Project', 'kelbe-project-tracker'); ?></button>
                    <a href="<?php echo esc_url(add_query_arg(array('view' => 'job', 'id' => $project_id), get_permalink())); ?>" class="kpt-button kpt-button--secondary"><?php _e('Cancel', 'kelbe-project-tracker'); ?></a>
                </div>
            </form>
        </div>
        <?php
    }
    
    /**
     * Render team management view
     */
    private function render_team() {
        if (!$this->is_pm()) {
            echo '<p>' . __('Access denied.', 'kelbe-project-tracker') . '</p>';
            return;
        }
        
        ?>
        <div class="kpt-portal__team">
            <h2 class="kpt-portal__page-title"><?php _e('Team Management', 'kelbe-project-tracker'); ?></h2>
            <p><?php _e('Team management features coming soon.', 'kelbe-project-tracker'); ?></p>
        </div>
        <?php
    }
    
    /**
     * Render bids management view
     */
    private function render_bids() {
        if (!$this->is_pm()) {
            echo '<p>' . __('Access denied.', 'kelbe-project-tracker') . '</p>';
            return;
        }
        
        ?>
        <div class="kpt-portal__bids">
            <h2 class="kpt-portal__page-title"><?php _e('Bids Management', 'kelbe-project-tracker'); ?></h2>
            <p><?php _e('Bids management features coming soon.', 'kelbe-project-tracker'); ?></p>
        </div>
        <?php
    }
    
    /**
     * Render budget view
     */
    private function render_budget() {
        if (!$this->is_pm()) {
            echo '<p>' . __('Access denied.', 'kelbe-project-tracker') . '</p>';
            return;
        }
        
        ?>
        <div class="kpt-portal__budget">
            <h2 class="kpt-portal__page-title"><?php _e('Budget Overview', 'kelbe-project-tracker'); ?></h2>
            <p><?php _e('Budget features coming soon.', 'kelbe-project-tracker'); ?></p>
        </div>
        <?php
    }
    
    /**
     * Render leads management view
     */
    private function render_leads() {
        if (!$this->is_pm()) {
            echo '<p>' . __('Access denied.', 'kelbe-project-tracker') . '</p>';
            return;
        }
        
        ?>
        <div class="kpt-portal__leads">
            <h2 class="kpt-portal__page-title"><?php _e('Leads Management', 'kelbe-project-tracker'); ?></h2>
            <p><?php _e('Leads management features coming soon.', 'kelbe-project-tracker'); ?></p>
        </div>
        <?php
    }
    
    /**
     * Render checklist view
     */
    private function render_checklist() {
        ?>
        <div class="kpt-portal__checklist-view">
            <h2 class="kpt-portal__page-title"><?php _e('Checklist', 'kelbe-project-tracker'); ?></h2>
            <p><?php _e('Global checklist view coming soon.', 'kelbe-project-tracker'); ?></p>
        </div>
        <?php
    }
    
    /**
     * Render files view
     */
    private function render_files() {
        ?>
        <div class="kpt-portal__files-view">
            <h2 class="kpt-portal__page-title"><?php _e('Files', 'kelbe-project-tracker'); ?></h2>
            <p><?php _e('Global files view coming soon.', 'kelbe-project-tracker'); ?></p>
        </div>
        <?php
    }
    
    /**
     * Render change orders view
     */
    private function render_change_orders() {
        ?>
        <div class="kpt-portal__change-orders-view">
            <h2 class="kpt-portal__page-title"><?php _e('Change Orders', 'kelbe-project-tracker'); ?></h2>
            <p><?php _e('Global change orders view coming soon.', 'kelbe-project-tracker'); ?></p>
        </div>
        <?php
    }
    
    /**
     * Render calendar view
     */
    private function render_calendar() {
        ?>
        <div class="kpt-portal__calendar">
            <h2 class="kpt-portal__page-title"><?php _e('Calendar', 'kelbe-project-tracker'); ?></h2>
            <p><?php _e('Calendar features coming soon.', 'kelbe-project-tracker'); ?></p>
        </div>
        <?php
    }
    
    /**
     * Render project card
     *
     * @param WP_Post $project
     */
    private function render_project_card($project) {
        $customer_name = get_post_meta($project->ID, '_kpt_customer_name', true);
        $project_address = get_post_meta($project->ID, '_kpt_project_address', true);
        $project_status = get_post_meta($project->ID, '_kpt_project_status', true);
        $project_stage = get_post_meta($project->ID, '_kpt_project_stage', true);
        
        $job_url = add_query_arg(array('view' => 'job', 'id' => $project->ID), get_permalink());
        
        ?>
        <div class="kpt-project-card">
            <div class="kpt-project-card__header">
                <h3 class="kpt-project-card__title">
                    <a href="<?php echo esc_url($job_url); ?>"><?php echo esc_html($project->post_title); ?></a>
                </h3>
                <?php if ($project_status): ?>
                    <span class="kpt-badge kpt-badge--<?php echo esc_attr($project_status); ?>">
                        <?php echo esc_html(ucfirst(str_replace('_', ' ', $project_status))); ?>
                    </span>
                <?php endif; ?>
            </div>
            
            <div class="kpt-project-card__body">
                <?php if ($customer_name): ?>
                    <div class="kpt-project-card__meta">
                        <span class="kpt-project-card__meta-label"><?php _e('Customer:', 'kelbe-project-tracker'); ?></span>
                        <span class="kpt-project-card__meta-value"><?php echo esc_html($customer_name); ?></span>
                    </div>
                <?php endif; ?>
                
                <?php if ($project_address): ?>
                    <div class="kpt-project-card__meta">
                        <span class="kpt-project-card__meta-label"><?php _e('Location:', 'kelbe-project-tracker'); ?></span>
                        <span class="kpt-project-card__meta-value"><?php echo esc_html($project_address); ?></span>
                    </div>
                <?php endif; ?>
                
                <?php if ($project_stage): ?>
                    <div class="kpt-project-card__meta">
                        <span class="kpt-project-card__meta-label"><?php _e('Stage:', 'kelbe-project-tracker'); ?></span>
                        <span class="kpt-project-card__meta-value"><?php echo esc_html(sprintf(__('Stage %d', 'kelbe-project-tracker'), $project_stage)); ?></span>
                    </div>
                <?php endif; ?>
            </div>
            
            <div class="kpt-project-card__footer">
                <a href="<?php echo esc_url($job_url); ?>" class="kpt-button kpt-button--small">
                    <?php _e('View Project', 'kelbe-project-tracker'); ?>
                </a>
            </div>
        </div>
        <?php
    }
    
    /**
     * Render job details tab
     *
     * @param WP_Post $project
     */
    private function render_job_details($project) {
        $customer_name = get_post_meta($project->ID, '_kpt_customer_name', true);
        $customer_email = get_post_meta($project->ID, '_kpt_customer_email', true);
        $customer_phone = get_post_meta($project->ID, '_kpt_customer_phone', true);
        $project_address = get_post_meta($project->ID, '_kpt_project_address', true);
        $project_city = get_post_meta($project->ID, '_kpt_project_city', true);
        $project_status = get_post_meta($project->ID, '_kpt_project_status', true);
        $project_stage = get_post_meta($project->ID, '_kpt_project_stage', true);
        
        ?>
        <div class="kpt-job-details">
            <h3 class="kpt-job-details__title"><?php _e('Project Details', 'kelbe-project-tracker'); ?></h3>
            
            <div class="kpt-job-details__grid">
                <div class="kpt-job-details__section">
                    <h4 class="kpt-job-details__section-title"><?php _e('Customer Information', 'kelbe-project-tracker'); ?></h4>
                    <dl class="kpt-job-details__list">
                        <?php if ($customer_name): ?>
                            <dt><?php _e('Name:', 'kelbe-project-tracker'); ?></dt>
                            <dd><?php echo esc_html($customer_name); ?></dd>
                        <?php endif; ?>
                        
                        <?php if ($customer_email): ?>
                            <dt><?php _e('Email:', 'kelbe-project-tracker'); ?></dt>
                            <dd><a href="mailto:<?php echo esc_attr($customer_email); ?>"><?php echo esc_html($customer_email); ?></a></dd>
                        <?php endif; ?>
                        
                        <?php if ($customer_phone): ?>
                            <dt><?php _e('Phone:', 'kelbe-project-tracker'); ?></dt>
                            <dd><a href="tel:<?php echo esc_attr($customer_phone); ?>"><?php echo esc_html($customer_phone); ?></a></dd>
                        <?php endif; ?>
                    </dl>
                </div>
                
                <div class="kpt-job-details__section">
                    <h4 class="kpt-job-details__section-title"><?php _e('Project Information', 'kelbe-project-tracker'); ?></h4>
                    <dl class="kpt-job-details__list">
                        <?php if ($project_address): ?>
                            <dt><?php _e('Address:', 'kelbe-project-tracker'); ?></dt>
                            <dd><?php echo esc_html($project_address); ?></dd>
                        <?php endif; ?>
                        
                        <?php if ($project_city): ?>
                            <dt><?php _e('City:', 'kelbe-project-tracker'); ?></dt>
                            <dd><?php echo esc_html($project_city); ?></dd>
                        <?php endif; ?>
                        
                        <?php if ($project_status): ?>
                            <dt><?php _e('Status:', 'kelbe-project-tracker'); ?></dt>
                            <dd><?php echo esc_html(ucfirst(str_replace('_', ' ', $project_status))); ?></dd>
                        <?php endif; ?>
                        
                        <?php if ($project_stage): ?>
                            <dt><?php _e('Stage:', 'kelbe-project-tracker'); ?></dt>
                            <dd><?php echo esc_html(sprintf(__('Stage %d', 'kelbe-project-tracker'), $project_stage)); ?></dd>
                        <?php endif; ?>
                    </dl>
                </div>
            </div>
        </div>
        <?php
    }
    
    /**
     * Render job checklist tab
     *
     * @param WP_Post $project
     */
    private function render_job_checklist($project) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_checklist_items';
        
        $items = $wpdb->get_results($wpdb->prepare(
            "SELECT * FROM $table WHERE project_id = %d ORDER BY stage, sort_order",
            $project->ID
        ));
        
        ?>
        <div class="kpt-job-checklist">
            <h3 class="kpt-job-checklist__title"><?php _e('Project Checklist', 'kelbe-project-tracker'); ?></h3>
            
            <?php if (empty($items)): ?>
                <p><?php _e('No checklist items found.', 'kelbe-project-tracker'); ?></p>
            <?php else: ?>
                <div class="kpt-checklist-items">
                    <?php foreach ($items as $item): ?>
                        <div class="kpt-checklist-item <?php echo $item->is_completed ? 'kpt-checklist-item--completed' : ''; ?>">
                            <div class="kpt-checklist-item__checkbox">
                                <input type="checkbox" <?php checked($item->is_completed, 1); ?> disabled>
                            </div>
                            <div class="kpt-checklist-item__content">
                                <div class="kpt-checklist-item__text"><?php echo esc_html($item->item_text); ?></div>
                                <?php if ($item->trade_type): ?>
                                    <div class="kpt-checklist-item__meta">
                                        <span class="kpt-badge"><?php echo esc_html($item->trade_type); ?></span>
                                    </div>
                                <?php endif; ?>
                            </div>
                        </div>
                    <?php endforeach; ?>
                </div>
            <?php endif; ?>
        </div>
        <?php
    }
    
    /**
     * Render job files tab
     *
     * @param WP_Post $project
     */
    private function render_job_files($project) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_files';
        
        $files = $wpdb->get_results($wpdb->prepare(
            "SELECT * FROM $table WHERE project_id = %d ORDER BY created_at DESC",
            $project->ID
        ));
        
        ?>
        <div class="kpt-job-files">
            <h3 class="kpt-job-files__title"><?php _e('Project Files', 'kelbe-project-tracker'); ?></h3>
            
            <?php if (empty($files)): ?>
                <p><?php _e('No files found.', 'kelbe-project-tracker'); ?></p>
            <?php else: ?>
                <div class="kpt-files-list">
                    <?php foreach ($files as $file): ?>
                        <div class="kpt-file-item">
                            <div class="kpt-file-item__icon">📄</div>
                            <div class="kpt-file-item__info">
                                <a href="<?php echo esc_url($file->file_url); ?>" target="_blank" class="kpt-file-item__name">
                                    <?php echo esc_html($file->file_name); ?>
                                </a>
                                <div class="kpt-file-item__meta">
                                    <?php echo esc_html(date_i18n(get_option('date_format'), strtotime($file->created_at))); ?>
                                </div>
                            </div>
                            <div class="kpt-file-item__actions">
                                <a href="<?php echo esc_url($file->file_url); ?>" download class="kpt-button kpt-button--small">
                                    <?php _e('Download', 'kelbe-project-tracker'); ?>
                                </a>
                            </div>
                        </div>
                    <?php endforeach; ?>
                </div>
            <?php endif; ?>
        </div>
        <?php
    }
    
    /**
     * Render job bids tab
     *
     * @param WP_Post $project
     */
    private function render_job_bids($project) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_trade_bids';
        
        $bids = $wpdb->get_results($wpdb->prepare(
            "SELECT * FROM $table WHERE project_id = %d ORDER BY submitted_at DESC",
            $project->ID
        ));
        
        ?>
        <div class="kpt-job-bids">
            <h3 class="kpt-job-bids__title"><?php _e('Project Bids', 'kelbe-project-tracker'); ?></h3>
            
            <?php if (empty($bids)): ?>
                <p><?php _e('No bids found.', 'kelbe-project-tracker'); ?></p>
            <?php else: ?>
                <div class="kpt-bids-list">
                    <?php foreach ($bids as $bid): ?>
                        <div class="kpt-bid-item">
                            <div class="kpt-bid-item__header">
                                <div class="kpt-bid-item__title">
                                    <?php echo esc_html($bid->trade_type); ?>
                                    <?php if ($bid->bid_number): ?>
                                        <span class="kpt-bid-item__number">#<?php echo esc_html($bid->bid_number); ?></span>
                                    <?php endif; ?>
                                </div>
                                <span class="kpt-badge kpt-badge--<?php echo esc_attr($bid->status); ?>">
                                    <?php echo esc_html(ucfirst($bid->status)); ?>
                                </span>
                            </div>
                            <div class="kpt-bid-item__body">
                                <div class="kpt-bid-item__amount">
                                    <?php echo '$' . number_format($bid->total, 2); ?>
                                </div>
                                <?php if ($bid->submitted_at): ?>
                                    <div class="kpt-bid-item__date">
                                        <?php echo esc_html(sprintf(__('Submitted: %s', 'kelbe-project-tracker'), date_i18n(get_option('date_format'), strtotime($bid->submitted_at)))); ?>
                                    </div>
                                <?php endif; ?>
                            </div>
                        </div>
                    <?php endforeach; ?>
                </div>
            <?php endif; ?>
        </div>
        <?php
    }
    
    /**
     * Render job change orders tab
     *
     * @param WP_Post $project
     */
    private function render_job_change_orders($project) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_change_orders';
        
        $change_orders = $wpdb->get_results($wpdb->prepare(
            "SELECT * FROM $table WHERE project_id = %d ORDER BY created_at DESC",
            $project->ID
        ));
        
        ?>
        <div class="kpt-job-change-orders">
            <h3 class="kpt-job-change-orders__title"><?php _e('Change Orders', 'kelbe-project-tracker'); ?></h3>
            
            <?php if (empty($change_orders)): ?>
                <p><?php _e('No change orders found.', 'kelbe-project-tracker'); ?></p>
            <?php else: ?>
                <div class="kpt-change-orders-list">
                    <?php foreach ($change_orders as $co): ?>
                        <div class="kpt-change-order-item">
                            <div class="kpt-change-order-item__header">
                                <div class="kpt-change-order-item__title"><?php echo esc_html($co->title); ?></div>
                                <span class="kpt-badge kpt-badge--<?php echo esc_attr($co->status); ?>">
                                    <?php echo esc_html(ucfirst($co->status)); ?>
                                </span>
                            </div>
                            <div class="kpt-change-order-item__body">
                                <?php if ($co->description): ?>
                                    <p><?php echo esc_html($co->description); ?></p>
                                <?php endif; ?>
                                <div class="kpt-change-order-item__amount">
                                    <?php echo '$' . number_format($co->amount, 2); ?>
                                </div>
                                <div class="kpt-change-order-item__date">
                                    <?php echo esc_html(date_i18n(get_option('date_format'), strtotime($co->created_at))); ?>
                                </div>
                            </div>
                        </div>
                    <?php endforeach; ?>
                </div>
            <?php endif; ?>
        </div>
        <?php
    }
}
