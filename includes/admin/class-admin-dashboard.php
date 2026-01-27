<?php
/**
 * Admin Dashboard Widgets
 *
 * Handles custom dashboard widgets for project tracking.
 *
 * @package Kelbe_Project_Tracker
 * @since 1.0.0
 */

// Exit if accessed directly
if (!defined('ABSPATH')) {
    exit;
}

/**
 * Class KPT_Admin_Dashboard
 */
class KPT_Admin_Dashboard {
    
    /**
     * Single instance of the class
     *
     * @var KPT_Admin_Dashboard
     */
    private static $instance = null;
    
    /**
     * Get instance
     *
     * @return KPT_Admin_Dashboard
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
        add_action('wp_dashboard_setup', array($this, 'add_dashboard_widgets'));
        add_action('admin_enqueue_scripts', array($this, 'enqueue_scripts'));
    }
    
    /**
     * Add dashboard widgets
     */
    public function add_dashboard_widgets() {
        if (!current_user_can('read')) {
            return;
        }
        
        // Recent projects widget
        wp_add_dashboard_widget(
            'kpt_recent_projects',
            __('Recent Projects', 'kelbe-project-tracker'),
            array($this, 'render_recent_projects_widget')
        );
        
        // Pending bids widget
        if (current_user_can('manage_bids')) {
            wp_add_dashboard_widget(
                'kpt_pending_bids',
                __('Pending Bids', 'kelbe-project-tracker'),
                array($this, 'render_pending_bids_widget')
            );
        }
        
        // Budget overview widget
        if (current_user_can('view_budget')) {
            wp_add_dashboard_widget(
                'kpt_budget_overview',
                __('Budget Overview', 'kelbe-project-tracker'),
                array($this, 'render_budget_overview_widget')
            );
        }
        
        // Upcoming tasks widget
        wp_add_dashboard_widget(
            'kpt_upcoming_tasks',
            __('Upcoming Tasks', 'kelbe-project-tracker'),
            array($this, 'render_upcoming_tasks_widget')
        );
        
        // Lead statistics widget
        if (current_user_can('manage_leads')) {
            wp_add_dashboard_widget(
                'kpt_lead_statistics',
                __('Lead Statistics', 'kelbe-project-tracker'),
                array($this, 'render_lead_statistics_widget')
            );
        }
    }
    
    /**
     * Enqueue admin scripts
     *
     * @param string $hook Current admin page hook
     */
    public function enqueue_scripts($hook) {
        if ('index.php' !== $hook) {
            return;
        }
        
        wp_enqueue_style(
            'kpt-dashboard-widgets',
            KPT_PLUGIN_URL . 'assets/css/dashboard-widgets.css',
            array(),
            KPT_VERSION
        );
        
        wp_enqueue_script(
            'kpt-dashboard-widgets',
            KPT_PLUGIN_URL . 'assets/js/dashboard-widgets.js',
            array('jquery'),
            KPT_VERSION,
            true
        );
    }
    
    /**
     * Render recent projects widget
     */
    public function render_recent_projects_widget() {
        global $wpdb;
        
        $current_user_id = get_current_user_id();
        $user_role = $this->get_user_portal_role($current_user_id);
        
        $args = array(
            'post_type' => 'kpt_project',
            'posts_per_page' => 5,
            'orderby' => 'date',
            'order' => 'DESC',
            'post_status' => array('publish', 'draft')
        );
        
        // Filter by user role
        if ($user_role === 'client') {
            $args['meta_query'] = array(
                array(
                    'key' => '_kpt_client_id',
                    'value' => $current_user_id,
                    'compare' => '='
                )
            );
        } elseif ($user_role === 'contractor') {
            $project_ids = $wpdb->get_col($wpdb->prepare(
                "SELECT project_id FROM {$wpdb->prefix}kpt_team_members WHERE user_id = %d",
                $current_user_id
            ));
            
            if (!empty($project_ids)) {
                $args['post__in'] = $project_ids;
            } else {
                $args['post__in'] = array(0);
            }
        }
        
        $projects = get_posts($args);
        
        if (empty($projects)) {
            echo '<p>' . __('No recent projects found.', 'kelbe-project-tracker') . '</p>';
            return;
        }
        
        echo '<ul class="kpt-widget-list">';
        foreach ($projects as $project) {
            $status = get_post_meta($project->ID, '_kpt_project_status', true);
            $status_label = $this->get_status_label($status);
            
            printf(
                '<li><a href="%s">%s</a> <span class="kpt-status kpt-status-%s">%s</span></li>',
                esc_url(get_edit_post_link($project->ID)),
                esc_html($project->post_title),
                esc_attr($status),
                esc_html($status_label)
            );
        }
        echo '</ul>';
        
        printf(
            '<p class="kpt-widget-footer"><a href="%s">%s →</a></p>',
            esc_url(admin_url('edit.php?post_type=kpt_project')),
            __('View all projects', 'kelbe-project-tracker')
        );
    }
    
    /**
     * Render pending bids widget
     */
    public function render_pending_bids_widget() {
        global $wpdb;
        
        $table_name = $wpdb->prefix . 'kpt_bids';
        
        $bids = $wpdb->get_results(
            "SELECT b.*, p.post_title 
             FROM $table_name b
             LEFT JOIN {$wpdb->posts} p ON b.project_id = p.ID
             WHERE b.status = 'pending'
             ORDER BY b.created_at DESC
             LIMIT 5"
        );
        
        if (empty($bids)) {
            echo '<p>' . __('No pending bids.', 'kelbe-project-tracker') . '</p>';
            return;
        }
        
        echo '<ul class="kpt-widget-list">';
        foreach ($bids as $bid) {
            $contractor = get_userdata($bid->contractor_id);
            $contractor_name = $contractor ? $contractor->display_name : __('Unknown', 'kelbe-project-tracker');
            
            printf(
                '<li><strong>%s</strong><br><span class="kpt-widget-meta">%s - $%s</span></li>',
                esc_html($bid->post_title),
                esc_html($contractor_name),
                number_format($bid->total_amount, 2)
            );
        }
        echo '</ul>';
        
        printf(
            '<p class="kpt-widget-footer"><a href="%s">%s →</a></p>',
            esc_url(admin_url('admin.php?page=kpt-bids')),
            __('View all bids', 'kelbe-project-tracker')
        );
    }
    
    /**
     * Render budget overview widget
     */
    public function render_budget_overview_widget() {
        global $wpdb;
        
        $table_name = $wpdb->prefix . 'kpt_budgets';
        
        $stats = $wpdb->get_row(
            "SELECT 
                SUM(total_budget) as total_budget,
                SUM(total_spent) as total_spent,
                COUNT(DISTINCT project_id) as project_count
             FROM $table_name
             WHERE status = 'active'"
        );
        
        if (!$stats || $stats->project_count == 0) {
            echo '<p>' . __('No active projects with budgets.', 'kelbe-project-tracker') . '</p>';
            return;
        }
        
        $remaining = $stats->total_budget - $stats->total_spent;
        $percentage = $stats->total_budget > 0 ? ($stats->total_spent / $stats->total_budget) * 100 : 0;
        
        ?>
        <div class="kpt-budget-overview">
            <div class="kpt-budget-stat">
                <span class="kpt-budget-label"><?php _e('Total Budget', 'kelbe-project-tracker'); ?></span>
                <span class="kpt-budget-value">$<?php echo number_format($stats->total_budget, 2); ?></span>
            </div>
            <div class="kpt-budget-stat">
                <span class="kpt-budget-label"><?php _e('Total Spent', 'kelbe-project-tracker'); ?></span>
                <span class="kpt-budget-value">$<?php echo number_format($stats->total_spent, 2); ?></span>
            </div>
            <div class="kpt-budget-stat">
                <span class="kpt-budget-label"><?php _e('Remaining', 'kelbe-project-tracker'); ?></span>
                <span class="kpt-budget-value kpt-budget-remaining">$<?php echo number_format($remaining, 2); ?></span>
            </div>
            
            <div class="kpt-budget-progress">
                <div class="kpt-progress-bar">
                    <div class="kpt-progress-fill" style="width: <?php echo min($percentage, 100); ?>%"></div>
                </div>
                <span class="kpt-progress-label"><?php echo number_format($percentage, 1); ?>% <?php _e('Used', 'kelbe-project-tracker'); ?></span>
            </div>
            
            <p class="kpt-widget-meta"><?php printf(__('Across %d active projects', 'kelbe-project-tracker'), $stats->project_count); ?></p>
        </div>
        
        <?php
        printf(
            '<p class="kpt-widget-footer"><a href="%s">%s →</a></p>',
            esc_url(admin_url('admin.php?page=kpt-budget')),
            __('View detailed budget', 'kelbe-project-tracker')
        );
    }
    
    /**
     * Render upcoming tasks widget
     */
    public function render_upcoming_tasks_widget() {
        global $wpdb;
        
        $current_user_id = get_current_user_id();
        $table_name = $wpdb->prefix . 'kpt_checklist_items';
        
        $tasks = $wpdb->get_results($wpdb->prepare(
            "SELECT c.*, p.post_title 
             FROM $table_name c
             LEFT JOIN {$wpdb->posts} p ON c.project_id = p.ID
             WHERE c.status = 'pending'
             AND (c.assigned_to = %d OR c.assigned_to IS NULL)
             AND c.due_date >= CURDATE()
             ORDER BY c.due_date ASC
             LIMIT 5",
            $current_user_id
        ));
        
        if (empty($tasks)) {
            echo '<p>' . __('No upcoming tasks.', 'kelbe-project-tracker') . '</p>';
            return;
        }
        
        echo '<ul class="kpt-widget-list kpt-tasks-list">';
        foreach ($tasks as $task) {
            $due_date = $task->due_date ? date_i18n(get_option('date_format'), strtotime($task->due_date)) : '';
            $overdue = $task->due_date && strtotime($task->due_date) < time();
            
            printf(
                '<li class="%s">
                    <strong>%s</strong><br>
                    <span class="kpt-widget-meta">%s</span>
                    %s
                </li>',
                $overdue ? 'kpt-task-overdue' : '',
                esc_html($task->title),
                esc_html($task->post_title),
                $due_date ? '<span class="kpt-task-date">' . esc_html($due_date) . '</span>' : ''
            );
        }
        echo '</ul>';
    }
    
    /**
     * Render lead statistics widget
     */
    public function render_lead_statistics_widget() {
        global $wpdb;
        
        $table_name = $wpdb->prefix . 'kpt_leads';
        
        // Get stats for last 30 days
        $stats = $wpdb->get_row(
            "SELECT 
                COUNT(*) as total_leads,
                SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) as new_leads,
                SUM(CASE WHEN status = 'contacted' THEN 1 ELSE 0 END) as contacted_leads,
                SUM(CASE WHEN status = 'qualified' THEN 1 ELSE 0 END) as qualified_leads,
                SUM(CASE WHEN status = 'converted' THEN 1 ELSE 0 END) as converted_leads,
                SUM(CASE WHEN status = 'lost' THEN 1 ELSE 0 END) as lost_leads
             FROM $table_name
             WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)"
        );
        
        if (!$stats || $stats->total_leads == 0) {
            echo '<p>' . __('No leads in the last 30 days.', 'kelbe-project-tracker') . '</p>';
            return;
        }
        
        $conversion_rate = $stats->total_leads > 0 ? ($stats->converted_leads / $stats->total_leads) * 100 : 0;
        
        ?>
        <div class="kpt-lead-stats">
            <div class="kpt-stat-grid">
                <div class="kpt-stat-item">
                    <span class="kpt-stat-number"><?php echo absint($stats->total_leads); ?></span>
                    <span class="kpt-stat-label"><?php _e('Total Leads', 'kelbe-project-tracker'); ?></span>
                </div>
                <div class="kpt-stat-item">
                    <span class="kpt-stat-number"><?php echo absint($stats->new_leads); ?></span>
                    <span class="kpt-stat-label"><?php _e('New', 'kelbe-project-tracker'); ?></span>
                </div>
                <div class="kpt-stat-item">
                    <span class="kpt-stat-number"><?php echo absint($stats->qualified_leads); ?></span>
                    <span class="kpt-stat-label"><?php _e('Qualified', 'kelbe-project-tracker'); ?></span>
                </div>
                <div class="kpt-stat-item kpt-stat-highlight">
                    <span class="kpt-stat-number"><?php echo absint($stats->converted_leads); ?></span>
                    <span class="kpt-stat-label"><?php _e('Converted', 'kelbe-project-tracker'); ?></span>
                </div>
            </div>
            
            <div class="kpt-conversion-rate">
                <span class="kpt-conversion-label"><?php _e('Conversion Rate:', 'kelbe-project-tracker'); ?></span>
                <span class="kpt-conversion-value"><?php echo number_format($conversion_rate, 1); ?>%</span>
            </div>
            
            <p class="kpt-widget-meta"><?php _e('Last 30 days', 'kelbe-project-tracker'); ?></p>
        </div>
        
        <?php
        printf(
            '<p class="kpt-widget-footer"><a href="%s">%s →</a></p>',
            esc_url(admin_url('admin.php?page=kpt-leads')),
            __('View all leads', 'kelbe-project-tracker')
        );
    }
    
    /**
     * Get user portal role
     *
     * @param int $user_id User ID
     * @return string
     */
    private function get_user_portal_role($user_id) {
        $portal_role = get_user_meta($user_id, 'kpt_portal_role', true);
        
        if (!$portal_role) {
            $user = get_userdata($user_id);
            if ($user && in_array('administrator', $user->roles)) {
                return 'administrator';
            }
            return 'client';
        }
        
        return $portal_role;
    }
    
    /**
     * Get status label
     *
     * @param string $status Status slug
     * @return string
     */
    private function get_status_label($status) {
        $labels = array(
            'lead' => __('Lead', 'kelbe-project-tracker'),
            'proposal' => __('Proposal', 'kelbe-project-tracker'),
            'active' => __('Active', 'kelbe-project-tracker'),
            'on_hold' => __('On Hold', 'kelbe-project-tracker'),
            'completed' => __('Completed', 'kelbe-project-tracker'),
            'cancelled' => __('Cancelled', 'kelbe-project-tracker')
        );
        
        return isset($labels[$status]) ? $labels[$status] : ucfirst($status);
    }
}

// Initialize
KPT_Admin_Dashboard::get_instance();
